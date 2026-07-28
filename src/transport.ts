import type { MetrixWireConfig, TraceData } from './types'

/**
 * Batches traces and flushes them to the ingest endpoint. Every network path is
 * wrapped so a dead/slow MetrixWire API can never crash or block the host app:
 * short timeout, all errors swallowed, sends happen off the request path.
 */
export class Transport {
  private queue: TraceData[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private config: MetrixWireConfig
  private warned = false

  constructor(config: MetrixWireConfig) {
    this.config = config
  }

  /** Log the first delivery problem once, so misconfig isn't fully invisible. */
  private warnOnce(detail: string): void {
    if (this.warned) return
    this.warned = true
    console.warn(`[metrixwire] traces are not being delivered: ${detail} (endpoint=${this.config.endpoint}). This is logged once.`)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs)
    // Don't keep the process alive just for the flush timer.
    if (typeof this.timer.unref === 'function') this.timer.unref()
    // Last-chance flush on shutdown.
    process.on('beforeExit', () => void this.flush())
  }

  enqueue(trace: TraceData): void {
    if (!this.config.enabled) return
    this.queue.push(trace)
    if (this.queue.length >= this.config.maxBatch) void this.flush()
  }

  async flush(): Promise<void> {
    if (!this.config.enabled || this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), this.config.timeoutMs)
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.config.apiKey },
        body: JSON.stringify({ traces: batch }),
        signal: controller.signal,
      }).catch((e: unknown) => {
        this.warnOnce(`request failed (${(e as Error)?.message ?? 'network error'})`)
        return null
      })
      clearTimeout(t)
      // A non-2xx, or a response whose content-type isn't JSON (e.g. an HTML SPA
      // page answering 200), means the traces did NOT reach the ingest API.
      if (res && (!res.ok || !res.headers.get('content-type')?.includes('json'))) {
        this.warnOnce(`unexpected response ${res.status} ${res.headers.get('content-type') ?? ''}`.trim())
      }
    } catch {
      // Swallow everything — monitoring must never break the app.
    }
  }
}
