export { MetrixWire } from './client'
export { instrumentPrisma } from './adapters/prisma'
// Error-boundary primitive for frameworks the SDK can't hook automatically
// (bare http, a custom error middleware). NOT for manual span instrumentation —
// requests/queries/etc. are still captured automatically.
export { captureException } from './trace'
// Optional framework helpers. HTTP frameworks are traced automatically by the
// universal http.Server patch — these only refine the route name (and, for
// Elysia on Bun, open the trace since Bun.serve bypasses node:http).
export { fastifyPlugin } from './frameworks/fastify'
export { koaMiddleware } from './frameworks/koa'
export { elysiaPlugin } from './frameworks/elysia'
export type { InitOptions, MetrixWireConfig, TraceData, SpanData, SpanType, ExceptionMeta } from './types'
