import type { InitOptions, MetrixWireConfig, TraceData } from './types'
import { Transport } from './transport'
import { installAll } from './adapters/registry'

const DEFAULTS = {
  endpoint: 'https://metrixwire.com/ingest',
  flushIntervalMs: 5000,
  enabled: true,
  timeoutMs: 3000,
  maxBatch: 20,
  captureSource: true,
}

/**
 * Traces are always POSTed to the collector's `/ingest` path. Accept either a
 * bare host (`https://metrixwire.com`) or a full ingest URL and normalize to the
 * latter — so a copy-pasted base URL can't silently ship traces to the dashboard
 * SPA (which answers 200 to any POST) instead of the ingest API.
 */
function normalizeEndpoint(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return /\/ingest$/.test(trimmed) ? trimmed : `${trimmed}/ingest`
}

/**
 * The SDK is zero-config: call `init()` once and every request, database query,
 * outbound HTTP call, cache op and queue job is instrumented automatically —
 * there is no manual span/middleware API to wire up. This class only holds
 * config + the transport; all instrumentation lives in the adapters.
 */
class MetrixWireClient {
  config: MetrixWireConfig | null = null
  transport: Transport | null = null

  init(opts: InitOptions = {}): void {
    if (this.config) return // already initialised — no-op
    // Zero-config: fall back to the standard env vars so `MetrixWire.init()` with
    // no arguments works as long as METRIXWIRE_KEY / METRIXWIRE_ENDPOINT are set.
    const apiKey = opts.apiKey ?? process.env.METRIXWIRE_KEY ?? ''
    const enabled = opts.enabled ?? DEFAULTS.enabled
    if (!apiKey && enabled) {
      // No key: run in disabled mode instead of throwing.
      console.warn('[metrixwire] no apiKey provided (set METRIXWIRE_KEY or pass apiKey) — SDK disabled.')
    }
    const endpoint = normalizeEndpoint(opts.endpoint ?? process.env.METRIXWIRE_ENDPOINT ?? DEFAULTS.endpoint)
    this.config = {
      apiKey,
      endpoint,
      flushIntervalMs: opts.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
      enabled: enabled && !!apiKey,
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      maxBatch: opts.maxBatch ?? DEFAULTS.maxBatch,
      captureSource: opts.captureSource ?? DEFAULTS.captureSource,
    }
    this.transport = new Transport(this.config)
    if (this.config.enabled) {
      this.transport.start()
      // Auto-detect and patch everything present: http.Server (all frameworks),
      // pg, mysql2, ioredis, outbound http/fetch, BullMQ.
      try {
        installAll(this)
      } catch (e) {
        console.warn('[metrixwire] adapter install failed:', (e as Error)?.message)
      }
    }
  }

  enqueue(trace: TraceData): void {
    this.transport?.enqueue(trace)
  }

  /** Manually flush the queue (e.g. before a short-lived process exits). */
  async flush(): Promise<void> {
    await this.transport?.flush()
  }

  isSourceCaptureOn(): boolean {
    return this.config?.captureSource ?? true
  }
}

/** Singleton — the SDK's public surface. */
export const MetrixWire = new MetrixWireClient()
export type { MetrixWireClient }
