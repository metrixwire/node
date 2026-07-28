export type SpanType = 'db_query' | 'http_call' | 'custom'

export interface SpanData {
  type: SpanType
  description: string
  startedAt: string // ISO8601
  durationMs: number
  sourceLocation?: string
  /** Optional signal: { statusCode } for http_call, { rowCount } for db_query. */
  meta?: Record<string, unknown>
}

export interface ExceptionMeta {
  type: string
  message: string
  stack?: string
}

export interface TraceData {
  route: string
  method?: string
  startedAt: string // ISO8601
  durationMs: number
  status: 'success' | 'error'
  spans: SpanData[]
  /** Optional trace-level signal: { memoryMb, exception }. */
  meta?: Record<string, unknown>
}

export interface MetrixWireConfig {
  apiKey: string
  /** Full ingest URL. Default: http://localhost:3000/ingest */
  endpoint: string
  /** How often the transport flushes queued traces. Default: 5000ms */
  flushIntervalMs: number
  /** Master switch. When false, the SDK does nothing. Default: true */
  enabled: boolean
  /** Per-request HTTP timeout for sending traces. Default: 3000ms */
  timeoutMs: number
  /** Flush immediately once this many traces are queued. Default: 20 */
  maxBatch: number
  /** Capture file:line source locations for spans. Default: true */
  captureSource: boolean
}

export interface InitOptions {
  /** Falls back to process.env.METRIXWIRE_KEY when omitted. */
  apiKey?: string
  /**
   * Collector base URL or full ingest URL. Falls back to
   * process.env.METRIXWIRE_ENDPOINT. A bare host is accepted — the SDK appends
   * `/ingest` automatically.
   */
  endpoint?: string
  flushIntervalMs?: number
  enabled?: boolean
  timeoutMs?: number
  maxBatch?: number
  captureSource?: boolean
}
