import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { MetrixWireClient } from '../client'
import { installPg } from './pg'
import { installMysql2 } from './mysql2'
import { installHttp } from './http'
import { installRedis } from './redis'
import { installHttpServer } from './server'
import { installBullMQ } from './bullmq'

// Resolve optional integrations relative to the host app's working directory,
// which is where its pg/mysql2 live. Works in both ESM and CJS output.
const appRequire = createRequire(join(process.cwd(), 'noop.js'))

function safeRequire<T = any>(name: string): T | null {
  try {
    return appRequire(name) as T
  } catch {
    try {
      // Fall back to the SDK's own resolution (hoisted node_modules).
      return require(name) as T
    } catch {
      return null
    }
  }
}

let installed = false

/**
 * Auto-detect installed libraries and patch the ones that are present. This is
 * the whole zero-config story: one call and every request, query, HTTP call,
 * cache op and queue job is instrumented — no framework middleware to register.
 * Idempotent.
 */
export function installAll(client: MetrixWireClient): void {
  if (installed) return
  installed = true

  // Universal request tracing: opens a trace for every http/https request,
  // across Express, Koa, NestJS, Hapi, Fastify's core and bare http.
  installHttpServer(client)

  // Outbound HTTP: covers fetch, axios, got, node-fetch (all ride http/https).
  installHttp()

  const pg = safeRequire('pg')
  if (pg) installPg(pg)

  const mysql2 = safeRequire('mysql2')
  if (mysql2) installMysql2(mysql2)

  // ioredis: cache spans (meta.kind='cache') for the slow_cache_op detector.
  const ioredis = safeRequire('ioredis')
  if (ioredis) installRedis(ioredis)

  // BullMQ: trace each processed job as its own trace.
  const bullmq = safeRequire('bullmq')
  if (bullmq) installBullMQ(bullmq, client)

  // Prisma has its own query engine → instrument per-client via
  // `instrumentPrisma(client)` (see adapters/prisma.ts); no global patch here.
}
