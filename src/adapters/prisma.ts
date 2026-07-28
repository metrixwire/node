import { currentContext, recordSpan } from '../context'
import { captureSource } from '../source'
import { MetrixWire } from '../client'

/**
 * Prisma runs its own query engine, so it can't be patched at the driver level
 * like pg/mysql2. Instead, wrap the client with a `$extends` query hook. Usage:
 *
 *   import { instrumentPrisma } from '@metrixwire/node'
 *   const prisma = instrumentPrisma(new PrismaClient())
 *
 * Returns the extended client (call before using it for queries).
 */
export function instrumentPrisma<T extends { $extends: (ext: any) => any }>(client: T): T {
  return client.$extends({
    query: {
      async $allOperations({ model, operation, args, query }: any) {
        const ctx = currentContext()
        const start = Date.now()
        const source = MetrixWire.isSourceCaptureOn() ? captureSource() : undefined
        try {
          return await query(args)
        } finally {
          try {
            const desc = model ? `${model}.${operation}` : String(operation)
            recordSpan(ctx, 'db_query', desc, Date.now() - start, start, source)
          } catch {
            /* swallow */
          }
        }
      },
    },
  }) as T
}
