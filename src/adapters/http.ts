import http from 'node:http'
import https from 'node:https'
import { currentContext, recordSpan, type TraceContext } from '../context'
import { captureSource } from '../source'
import { MetrixWire } from '../client'

const PATCHED = Symbol.for('metrixwire.http.patched')

function recordHttp(
  ctx: TraceContext | undefined,
  method: string,
  url: string,
  start: number,
  source?: string,
  statusCode?: number,
) {
  try {
    const meta = typeof statusCode === 'number' && statusCode > 0 ? { statusCode } : undefined
    recordSpan(ctx, 'http_call', `${method} ${url}`, Date.now() - start, start, source, meta)
  } catch {
    /* swallow */
  }
}

/**
 * Patch global `fetch` and the `http`/`https` `.request` methods. undici-based
 * `fetch` doesn't ride the http module, so it's wrapped separately; axios, got
 * and node-fetch all go through http/https and are covered by that patch. The
 * active trace context is captured synchronously at the call site.
 */
export function installHttp(): void {
  patchFetch()
  patchModule(http)
  patchModule(https)
}

function patchFetch(): void {
  const g = globalThis as any
  if (typeof g.fetch !== 'function' || g.fetch[PATCHED]) return
  const original = g.fetch.bind(globalThis)

  const wrapped = async function (input: any, init?: any) {
    const ctx = currentContext()
    if (!ctx) return original(input, init)
    const start = Date.now()
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    // Don't record the SDK's own trace uploads as spans.
    if (isIngestUrl(url)) return original(input, init)
    const source = MetrixWire.isSourceCaptureOn() ? captureSource() : undefined
    let status: number | undefined
    try {
      const res = await original(input, init)
      status = typeof res?.status === 'number' ? res.status : undefined
      return res
    } finally {
      recordHttp(ctx, method, url, start, source, status)
    }
  }
  ;(wrapped as any)[PATCHED] = true
  g.fetch = wrapped
}

function patchModule(mod: typeof http | typeof https): void {
  if ((mod as any)[PATCHED]) return
  const originalRequest = mod.request

  mod.request = function patchedRequest(this: any, ...args: any[]) {
    const ctx = currentContext()
    if (!ctx) return originalRequest.apply(this, args as any)
    const start = Date.now()
    const { method, url } = describe(args, mod === https)
    if (isIngestUrl(url)) return originalRequest.apply(this, args as any)
    const source = MetrixWire.isSourceCaptureOn() ? captureSource() : undefined

    const req = originalRequest.apply(this, args as any)
    let recorded = false
    let statusCode: number | undefined
    const once = () => {
      if (recorded) return
      recorded = true
      recordHttp(ctx, method, url, start, source, statusCode)
    }
    req.on('response', (res: any) => {
      statusCode = typeof res?.statusCode === 'number' ? res.statusCode : undefined
      res.on('end', once)
    })
    req.on('error', once)
    req.on('close', once)
    return req
  } as any
  ;(mod as any)[PATCHED] = true
}

/** True when the URL targets the configured MetrixWire ingest endpoint. */
function isIngestUrl(url: string): boolean {
  try {
    const endpoint = MetrixWire.config?.endpoint
    if (!endpoint || !url) return false
    return url.startsWith(endpoint)
  } catch {
    return false
  }
}

function describe(args: any[], isHttps: boolean): { method: string; url: string } {
  let method = 'GET'
  let url = ''
  const [a0, a1] = args
  const proto = isHttps ? 'https://' : 'http://'
  try {
    if (typeof a0 === 'string') {
      url = a0
      const opts = typeof a1 === 'object' ? a1 : undefined
      if (opts?.method) method = String(opts.method).toUpperCase()
    } else if (a0 instanceof URL) {
      url = a0.toString()
      if (a1?.method) method = String(a1.method).toUpperCase()
    } else if (typeof a0 === 'object' && a0) {
      method = String(a0.method || 'GET').toUpperCase()
      const host = a0.hostname || a0.host || 'localhost'
      const path = a0.path || '/'
      const port = a0.port ? `:${a0.port}` : ''
      url = `${proto}${host}${port}${path}`
    }
  } catch {
    /* best effort */
  }
  return { method, url: url || `${proto}unknown` }
}
