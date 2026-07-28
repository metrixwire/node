import { MetrixWire } from '../client'
import { als, type TraceContext } from '../context'
import { finishActiveTrace, toExceptionMeta } from '../trace'
import type { InitOptions } from '../types'

/**
 * Elysia (Bun) plugin — the ONLY setup step needed on Bun/Elysia. Elysia runs on
 * `Bun.serve`, which does NOT go through node:http, so the universal http.Server
 * patch can't see it and the "import an init module first" dance that Node/Express
 * needs is pointless here. This plugin both initializes the SDK (idempotent, reads
 * METRIXWIRE_KEY / METRIXWIRE_ENDPOINT from the env) and opens the trace via the
 * request lifecycle hooks, pinning it onto the async context with `enterWith` so
 * the db/http/cache adapters attribute their spans to the right request.
 *
 *   import { Elysia } from 'elysia'
 *   import { elysiaPlugin } from '@metrixwire/node'
 *   const app = new Elysia().use(elysiaPlugin())   // that's it
 *
 * Pass options to configure explicitly instead of via env:
 *   new Elysia().use(elysiaPlugin({ apiKey: '...' }))
 */
export function elysiaPlugin(opts?: InitOptions) {
  // Init here so the plugin is self-contained. `init()` is a no-op if the app
  // already called it, so passing opts or pre-initializing both work.
  if (!MetrixWire.config) MetrixWire.init(opts ?? {})

  // Per-request state keyed by the Fetch Request (Elysia's `store` is global).
  const state = new WeakMap<object, { ctx: TraceContext; startHeap: number }>()

  return function metrixwire(app: any): any {
    if (!MetrixWire.config?.enabled) return app
    return app
      .onRequest((c: any) => {
        try {
          const request = c?.request
          const method = typeof request?.method === 'string' ? request.method : 'GET'
          const startedAt = Date.now()
          const ctx: TraceContext = { route: '', method, startedAt, spans: [] }
          if (request) state.set(request, { ctx, startHeap: safeHeap() })
          // Pin the context so downstream awaits (handlers, db calls) see it.
          als.enterWith(ctx)
        } catch {
          /* swallow */
        }
      })
      .onError((c: any) => {
        try {
          // NOT_FOUND is Elysia's routing-miss signal, not an application
          // exception — apps routinely turn it into a served static asset or a
          // plain 404 via their own onError. Capturing it here would false-report
          // every unmatched path (e.g. `GET /logo.svg`) as an unhandled exception.
          if (c?.code === 'NOT_FOUND') return
          const s = c?.request ? state.get(c.request) : undefined
          if (s && c?.error) s.ctx.exception = toExceptionMeta(c.error)
        } catch {
          /* swallow */
        }
      })
      .onAfterResponse((c: any) => {
        try {
          const request = c?.request
          const s = request ? state.get(request) : undefined
          if (!s) return
          state.delete(request)
          const pattern = typeof c?.route === 'string' ? c.route : undefined
          const path = pattern ?? new URL(request.url).pathname
          s.ctx.route = `${s.ctx.method} ${path}`
          const statusCode = numericStatus(c?.set?.status)
          // An error a lifecycle hook caught and recovered into a non-5xx
          // response was handled, not unhandled. Drop it so the trace reflects
          // the real outcome — this mirrors the node:http path, which only ever
          // records an exception that propagates out of the handler.
          if (statusCode < 500) s.ctx.exception = undefined
          finishActiveTrace(MetrixWire, s.ctx, {
            startHeap: s.startHeap,
            statusCode,
            responseBytes: responseSize(c?.response),
          })
        } catch {
          /* swallow */
        }
      })
  }
}

function numericStatus(status: unknown): number {
  if (typeof status === 'number') return status
  return 200
}

/**
 * Best-effort response body size. Bun's server bypasses node:http, so we can't
 * count written bytes — approximate from the handler's return value instead.
 */
function responseSize(response: unknown): number {
  try {
    if (typeof response === 'string') return Buffer.byteLength(response)
    if (response && typeof response === 'object') return Buffer.byteLength(JSON.stringify(response))
  } catch {
    /* ignore */
  }
  return 0
}

function safeHeap(): number {
  try {
    return process.memoryUsage().heapUsed
  } catch {
    return 0
  }
}
