import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExceptionMeta, SpanData, SpanType } from './types'

export interface TraceContext {
  route: string
  method?: string
  startedAt: number // epoch ms
  spans: SpanData[]
  /** Exception captured during this request (populated via captureException). */
  exception?: ExceptionMeta
  /** Epoch ms when the current DB transaction opened (BEGIN), if any. */
  txStart?: number
}

export const als = new AsyncLocalStorage<TraceContext>()

/** The trace context active right now, if any. */
export function currentContext(): TraceContext | undefined {
  return als.getStore()
}

export function hasActiveTrace(): boolean {
  return als.getStore() !== undefined
}

/**
 * Record a span against an EXPLICIT trace context. Adapters must capture the
 * context synchronously at the moment the instrumented call is made (not when
 * it completes) and pass it here — otherwise connection-pool callbacks that run
 * in a different async context would attribute spans to the wrong request.
 */
export function recordSpan(
  ctx: TraceContext | undefined,
  type: SpanType,
  description: string,
  durationMs: number,
  startedAtMs: number,
  sourceLocation?: string,
  meta?: Record<string, unknown>,
): void {
  if (!ctx || !description) return
  ctx.spans.push({
    type,
    description,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Math.max(0, Math.round(durationMs)),
    ...(sourceLocation ? { sourceLocation } : {}),
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  })
}
