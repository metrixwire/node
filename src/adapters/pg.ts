import { als, currentContext, recordSpan, type TraceContext } from '../context'
import { captureSource } from '../source'
import { MetrixWire } from '../client'

const PATCHED = Symbol.for('metrixwire.pg.patched')
const POOL_PATCHED = Symbol.for('metrixwire.pg.pool.patched')

/**
 * Patch node-postgres at the driver level. Because Drizzle, Knex, Sequelize and
 * TypeORM all run their SQL through `pg`'s `Client.prototype.query`, a single
 * patch here captures queries from every one of them.
 *
 * Two subtleties, both about AsyncLocalStorage + the connection pool:
 *  1. We capture the active trace context SYNCHRONOUSLY at the call site and
 *     record the span directly to it — never via getStore() after completion,
 *     which can run in a pool connection's (wrong) async context.
 *  2. We also wrap Pool.query to re-run its internal work inside the caller's
 *     context, so the client.query it eventually invokes sees the right trace.
 */
export function installPg(pg: any): void {
  patchClient(pg?.Client)
  patchPool(pg?.Pool)
}

function patchClient(Client: any): void {
  if (!Client?.prototype || Client.prototype[PATCHED]) return
  const proto = Client.prototype
  const original = proto.query
  if (typeof original !== 'function') return

  proto.query = function patchedQuery(this: any, ...args: any[]) {
    const ctx = currentContext()
    if (!ctx) return original.apply(this, args)

    const start = Date.now()
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text
    const source = MetrixWire.isSourceCaptureOn() ? captureSource() : undefined

    // Track BEGIN…COMMIT/ROLLBACK to emit a transaction span for the
    // long_transaction detector. Approximates the open duration as the time
    // from the BEGIN call to the COMMIT/ROLLBACK call.
    trackTransaction(ctx, text, start, source)

    const record = (rowCount?: number) => {
      try {
        const meta = typeof rowCount === 'number' && rowCount >= 0 ? { rowCount } : undefined
        if (typeof text === 'string') recordSpan(ctx, 'db_query', text, Date.now() - start, start, source, meta)
      } catch {
        /* never throw from instrumentation */
      }
    }

    // Callback form: query(text, [values], cb) — cb receives (err, res).
    const last = args[args.length - 1]
    if (typeof last === 'function') {
      args[args.length - 1] = function (this: any, ...cbArgs: any[]) {
        record(typeof cbArgs[1]?.rowCount === 'number' ? cbArgs[1].rowCount : undefined)
        return last.apply(this, cbArgs)
      }
      return original.apply(this, args)
    }

    // Promise form — the resolved value carries rowCount.
    const result = original.apply(this, args)
    if (result && typeof result.then === 'function') {
      return result.then(
        (v: any) => {
          record(typeof v?.rowCount === 'number' ? v.rowCount : undefined)
          return v
        },
        (e: any) => {
          record()
          throw e
        },
      )
    }
    record()
    return result
  }

  proto[PATCHED] = true
}

function patchPool(Pool: any): void {
  if (!Pool?.prototype || Pool.prototype[POOL_PATCHED]) return
  const proto = Pool.prototype
  const original = proto.query
  if (typeof original !== 'function') return

  // Re-establish the caller's trace context around the pool's internal
  // connection acquisition so the wrapped Client.query attributes correctly.
  // No span is recorded here — the inner Client.query does that.
  proto.query = function patchedPoolQuery(this: any, ...args: any[]) {
    const ctx = currentContext()
    if (!ctx) return original.apply(this, args)
    return als.run(ctx, () => original.apply(this, args))
  }

  proto[POOL_PATCHED] = true
}

/**
 * Detect transaction boundaries from the query text and, on COMMIT/ROLLBACK,
 * record a `custom` span tagged `meta.kind='transaction'` for the whole block.
 */
function trackTransaction(ctx: TraceContext, text: unknown, start: number, source?: string): void {
  if (typeof text !== 'string') return
  const norm = text.trim().toUpperCase()
  if (norm === 'BEGIN' || norm.startsWith('START TRANSACTION')) {
    ctx.txStart = start
  } else if (norm.startsWith('COMMIT') || norm.startsWith('ROLLBACK') || norm === 'END') {
    const txStart = ctx.txStart
    if (typeof txStart === 'number') {
      try {
        recordSpan(ctx, 'custom', 'DB transaction', Date.now() - txStart, txStart, source, { kind: 'transaction' })
      } catch {
        /* never throw from instrumentation */
      }
      ctx.txStart = undefined
    }
  }
}
