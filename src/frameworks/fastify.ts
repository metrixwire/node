import { captureException, setRoute } from '../trace'

/**
 * Optional Fastify plugin. The trace itself is already opened automatically by
 * the universal http.Server patch — this plugin only refines the route to the
 * matched pattern (e.g. `GET /users/:id`) and records handler errors, since
 * Fastify keeps that information on its own request wrapper, not the raw req.
 *
 *   import Fastify from 'fastify'
 *   import { fastifyPlugin } from '@metrixwire/node'
 *   const app = Fastify()
 *   app.register(fastifyPlugin)
 */
export function fastifyPlugin(fastify: any, _opts: any, done: () => void): void {
  try {
    fastify.addHook('onRequest', (req: any, _reply: any, next: () => void) => {
      try {
        const pattern = req?.routeOptions?.url ?? req?.routerPath ?? req?.routeConfig?.url
        if (typeof pattern === 'string') setRoute(`${req.method} ${pattern}`)
      } catch {
        /* swallow */
      }
      next()
    })
    fastify.addHook('onError', (_req: any, _reply: any, err: unknown, next: () => void) => {
      captureException(err)
      next()
    })
  } catch {
    /* if hook registration fails, tracing still works via the http patch */
  }
  done()
}
// Break Fastify's plugin encapsulation so the hooks apply to the whole app.
;(fastifyPlugin as any)[Symbol.for('skip-override')] = true
;(fastifyPlugin as any)[Symbol.for('fastify.display-name')] = 'metrixwire'
