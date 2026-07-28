import { currentContext, recordSpan, type TraceContext } from '../context'
import { captureSource } from '../source'
import { MetrixWire } from '../client'

const PATCHED = Symbol.for('metrixwire.redis.patched')

// Read commands whose result tells us whether it was a cache hit or a miss.
const READ_COMMANDS = new Set(['get', 'getex', 'mget', 'hget', 'hgetall', 'hmget', 'getbit', 'getrange'])

/**
 * Patch ioredis at the driver level. Every command (both `redis.get(...)` sugar
 * and pipelines) funnels through `Redis.prototype.sendCommand`, so a single
 * patch here captures them all. Each command becomes a `custom` span tagged
 * `meta.kind='cache'` so the `slow_cache_op` detector can flag slow lookups.
 * The trace context is captured synchronously at the call site.
 */
export function installRedis(ioredis: any): void {
  const Redis = ioredis?.default ?? ioredis
  const proto = Redis?.prototype
  if (!proto || proto[PATCHED]) return
  const original = proto.sendCommand
  if (typeof original !== 'function') return

  proto.sendCommand = function patchedSendCommand(this: any, command: any, ...rest: any[]) {
    const ctx = currentContext()
    if (!ctx || !command) return original.call(this, command, ...rest)

    const name = typeof command.name === 'string' ? command.name.toLowerCase() : 'command'
    const start = Date.now()
    const source = MetrixWire.isSourceCaptureOn() ? captureSource() : undefined

    const result = original.call(this, command, ...rest)
    const promise = result && typeof result.then === 'function' ? result : command?.promise
    if (promise && typeof promise.then === 'function') {
      promise.then(
        (v: any) => record(ctx, name, command, start, source, v),
        () => record(ctx, name, command, start, source, undefined),
      )
    }
    return result
  }

  proto[PATCHED] = true
}

function record(ctx: TraceContext, name: string, command: any, start: number, source?: string, value?: unknown): void {
  try {
    const meta: Record<string, unknown> = { kind: 'cache', op: name }
    const key = command?.args?.[0]
    if (typeof key === 'string' || typeof key === 'number') meta.key = String(key).slice(0, 128)
    if (READ_COMMANDS.has(name)) meta.hit = isHit(value)
    // Description is the command name only (not the key) so lookups aggregate
    // together instead of fragmenting per key.
    recordSpan(ctx, 'custom', `redis ${name}`, Date.now() - start, start, source, meta)
  } catch {
    /* never throw from instrumentation */
  }
}

function isHit(value: unknown): boolean {
  if (value == null) return false
  if (Array.isArray(value)) return value.some((v) => v != null)
  return true
}
