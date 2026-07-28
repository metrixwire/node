import { captureException, setRoute } from '../trace'

/**
 * Optional Koa middleware. The trace is already opened by the universal
 * http.Server patch; this only refines the route to the matched pattern (set by
 * `@koa/router` on `ctx._matchedRoute`) and records thrown errors. Register it
 * first: `app.use(koaMiddleware())`.
 */
export function koaMiddleware() {
  return async function metrixwireKoa(ctx: any, next: () => Promise<void>): Promise<void> {
    try {
      await next()
    } catch (err) {
      captureException(err)
      throw err
    } finally {
      try {
        const pattern = ctx?._matchedRoute ?? ctx?.routePath
        if (typeof pattern === 'string') setRoute(`${ctx.method} ${pattern}`)
      } catch {
        /* swallow */
      }
    }
  }
}
