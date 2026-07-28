import { currentContext, recordSpan } from '../context'
import { captureSource } from '../source'
import { MetrixWire } from '../client'

const PATCHED = Symbol.for('metrixwire.mysql2.patched')

/**
 * Patch mysql2's Connection prototype (`query` + `execute`). This captures raw
 * mysql2 usage as well as ORMs built on top of it (Sequelize, Knex, TypeORM
 * when configured for MySQL). Both callback and promise forms are handled.
 */
export function installMysql2(mysql2: any): void {
  // The Connection class lives on the module's internal path; resolve defensively.
  const Connection = mysql2?.Connection ?? tryLoadConnection(mysql2)
  const proto = Connection?.prototype
  if (!proto || proto[PATCHED]) return

  for (const fn of ['query', 'execute'] as const) {
    const original = proto[fn]
    if (typeof original !== 'function') continue
    proto[fn] = function patched(this: any, ...args: any[]) {
      const ctx = currentContext()
      if (!ctx) return original.apply(this, args)
      const start = Date.now()
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.sql
      const source = MetrixWire.isSourceCaptureOn() ? captureSource() : undefined
      const record = () => {
        try {
          if (typeof sql === 'string') recordSpan(ctx, 'db_query', sql, Date.now() - start, start, source)
        } catch {
          /* swallow */
        }
      }

      const last = args[args.length - 1]
      if (typeof last === 'function') {
        args[args.length - 1] = function (this: any, ...cbArgs: any[]) {
          record()
          return last.apply(this, cbArgs)
        }
        return original.apply(this, args)
      }
      const result = original.apply(this, args)
      if (result && typeof result.then === 'function') return result.finally(record)
      record()
      return result
    }
  }
  proto[PATCHED] = true
}

function tryLoadConnection(mysql2: any): any {
  try {
    // mysql2 exposes the class on createConnection(...).constructor in practice;
    // the direct export is the most reliable path when present.
    return mysql2?.Connection
  } catch {
    return null
  }
}
