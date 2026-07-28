import { als, type TraceContext } from './context'
import type { MetrixWireClient } from './client'
import type { ExceptionMeta, TraceData } from './types'

/**
 * The trace lifecycle shared by every entry point (the universal http.Server
 * patch, the Elysia plugin, the worker adapters). Nothing here is part of the
 * public API — users never open a trace by hand. Instrumentation must never
 * throw into the host application, so every path is defensive.
 */

/** Build an ExceptionMeta from an arbitrary thrown value. */
export function toExceptionMeta(err: unknown): ExceptionMeta | undefined {
  try {
    if (!err) return undefined
    const e = err as { name?: string; message?: unknown; stack?: unknown; constructor?: { name?: string } }
    return {
      type: e?.name || e?.constructor?.name || 'Error',
      message: String(e?.message ?? err),
      // Keep the top frames only — enough to fingerprint & guide a fix.
      stack: typeof e?.stack === 'string' ? e.stack.split('\n').slice(0, 8).join('\n') : undefined,
    }
  } catch {
    return undefined
  }
}

/** Attach an exception to the active trace. Used internally by adapters. */
export function captureException(err: unknown): void {
  try {
    const ctx = als.getStore()
    if (!ctx || !err) return
    ctx.exception = toExceptionMeta(err)
  } catch {
    /* instrumentation must never throw */
  }
}

/** Let a framework adapter refine the route on the active trace (e.g. /users/:id). */
export function setRoute(route: string): void {
  try {
    const ctx = als.getStore()
    if (ctx && route) ctx.route = route
  } catch {
    /* swallow */
  }
}

/**
 * Open a trace around a raw Node http request/response pair and run `handler`
 * inside its AsyncLocalStorage context. The finished trace is enqueued when the
 * response completes. Works for every framework that runs on node:http (Express,
 * Koa, NestJS, Hapi, raw http, …) because they all emit through http.Server.
 */
export function openHttpTrace(client: MetrixWireClient, req: any, res: any, handler: () => any): any {
  const startedAt = Date.now()
  const startHeap = safeHeap()
  const method = typeof req?.method === 'string' ? req.method : undefined
  const ctx: TraceContext = { route: '', method, startedAt, spans: [] }

  // Count response body bytes for the large_response_payload detector. We tally
  // what's written (works for chunked/streamed responses too) and fall back to
  // the Content-Length header. Both wrappers swallow any error.
  const bytes = { written: 0 }
  wrapResponseBytes(res, bytes)

  return als.run(ctx, () => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      try {
        const route = ctx.route || deriveHttpRoute(req)
        const status = (res?.statusCode ?? 0) >= 500 || ctx.exception ? 'error' : 'success'
        const meta = buildHttpMeta(ctx, res, startHeap, bytes.written)
        enqueueTrace(client, {
          route,
          method,
          startedAt,
          durationMs: Date.now() - startedAt,
          status,
          spans: ctx.spans,
          meta,
        })
      } catch {
        /* never let instrumentation break the response */
      }
    }
    try {
      res?.on?.('finish', finish)
      res?.on?.('close', finish)
    } catch {
      /* if res isn't an emitter, we simply won't enqueue */
    }
    try {
      return handler()
    } catch (err) {
      // Synchronous throw from the framework's request handling.
      captureException(err)
      throw err
    }
  })
}

/**
 * Open a trace around any non-HTTP unit of work (queue job, cron tick, CLI).
 * Records duration + exception automatically and enqueues on completion.
 */
export async function runTrace<T>(
  client: MetrixWireClient,
  info: { route: string; method?: string },
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!client.config?.enabled) return fn()
  const startedAt = Date.now()
  const startHeap = safeHeap()
  const ctx: TraceContext = { route: info.route, method: info.method ?? 'JOB', startedAt, spans: [] }
  return als.run(ctx, async () => {
    let errored = false
    try {
      return await fn()
    } catch (err) {
      errored = true
      captureException(err)
      throw err
    } finally {
      try {
        const meta: Record<string, unknown> = {}
        const memoryMb = memoryDeltaMb(startHeap)
        if (memoryMb > 0) meta.memoryMb = memoryMb
        if (ctx.exception) meta.exception = ctx.exception
        enqueueTrace(client, {
          route: ctx.route,
          method: ctx.method,
          startedAt,
          durationMs: Date.now() - startedAt,
          status: errored || ctx.exception ? 'error' : 'success',
          spans: ctx.spans,
          meta,
        })
      } catch {
        /* swallow */
      }
    }
  })
}

/**
 * Finish a trace whose context is already active but whose response lifecycle
 * the caller manages (used by the Elysia plugin, which drives the trace via
 * lifecycle hooks rather than an http.Server 'finish' event).
 */
export function finishActiveTrace(
  client: MetrixWireClient,
  ctx: TraceContext,
  opts: { startHeap?: number; statusCode?: number; responseBytes?: number } = {},
): void {
  try {
    const meta: Record<string, unknown> = {}
    if (typeof opts.startHeap === 'number') {
      const memoryMb = memoryDeltaMb(opts.startHeap)
      if (memoryMb > 0) meta.memoryMb = memoryMb
    }
    if (ctx.exception) meta.exception = ctx.exception
    if (opts.responseBytes && opts.responseBytes > 0) meta.responseBytes = opts.responseBytes
    const status = (opts.statusCode ?? 0) >= 500 || ctx.exception ? 'error' : 'success'
    enqueueTrace(client, {
      route: ctx.route,
      method: ctx.method,
      startedAt: ctx.startedAt,
      durationMs: Date.now() - ctx.startedAt,
      status,
      spans: ctx.spans,
      meta,
    })
  } catch {
    /* swallow */
  }
}

// ── internal helpers ─────────────────────────────────────────────────────────

interface TraceInput {
  route: string
  method?: string
  startedAt: number // epoch ms
  durationMs: number
  status: 'success' | 'error'
  spans: TraceData['spans']
  meta?: Record<string, unknown>
}

function enqueueTrace(client: MetrixWireClient, t: TraceInput): void {
  const trace: TraceData = {
    route: t.route,
    method: t.method,
    startedAt: new Date(t.startedAt).toISOString(),
    durationMs: t.durationMs,
    status: t.status,
    spans: t.spans,
    ...(t.meta && Object.keys(t.meta).length ? { meta: t.meta } : {}),
  }
  client.enqueue(trace)
}

function buildHttpMeta(ctx: TraceContext, res: any, startHeap: number, bytesWritten: number): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  const memoryMb = memoryDeltaMb(startHeap)
  if (memoryMb > 0) meta.memoryMb = memoryMb
  if (ctx.exception) meta.exception = ctx.exception
  const headerLen = Number(res?.getHeader?.('content-length'))
  const responseBytes = bytesWritten > 0 ? bytesWritten : Number.isFinite(headerLen) ? headerLen : 0
  if (responseBytes > 0) meta.responseBytes = responseBytes
  return meta
}

/** Prefer the matched route pattern (stable across ids); fall back to the path. */
function deriveHttpRoute(req: any): string {
  try {
    const method = req?.method ?? 'GET'
    // Express exposes the matched route on req.route.path (+ req.baseUrl for routers).
    const pattern = req?.route?.path
    if (typeof pattern === 'string') {
      const base = typeof req?.baseUrl === 'string' ? req.baseUrl : ''
      return `${method} ${base}${pattern}`
    }
    const raw = req?.originalUrl ?? req?.url ?? '/'
    // Strip the query string so paths aggregate.
    const path = String(raw).split('?')[0] || '/'
    return `${method} ${path}`
  } catch {
    return `${req?.method ?? 'GET'} /`
  }
}

function wrapResponseBytes(res: any, bytes: { written: number }): void {
  try {
    const origWrite = res?.write
    const origEnd = res?.end
    if (typeof origWrite === 'function') {
      res.write = function (chunk: any, ...rest: any[]) {
        bytes.written += byteLen(chunk)
        return origWrite.call(this, chunk, ...rest)
      }
    }
    if (typeof origEnd === 'function') {
      res.end = function (chunk: any, ...rest: any[]) {
        bytes.written += byteLen(chunk)
        return origEnd.call(this, chunk, ...rest)
      }
    }
  } catch {
    /* leave res untouched if wrapping fails */
  }
}

/** Best-effort byte length of a response chunk (Buffer or string); 0 otherwise. */
function byteLen(chunk: unknown): number {
  try {
    if (!chunk) return 0
    if (typeof chunk === 'string') return Buffer.byteLength(chunk)
    if (Buffer.isBuffer(chunk)) return chunk.length
    if (chunk instanceof Uint8Array) return chunk.byteLength
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

function memoryDeltaMb(startHeap: number): number {
  try {
    return Math.round((process.memoryUsage().heapUsed - startHeap) / (1024 * 1024))
  } catch {
    return 0
  }
}
