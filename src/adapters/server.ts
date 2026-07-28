import http from 'node:http'
import https from 'node:https'
import type { MetrixWireClient } from '../client'
import { openHttpTrace } from '../trace'

const PATCHED = Symbol.for('metrixwire.httpserver.patched')

/**
 * Patch the `request` event of every http/https server so a trace is opened for
 * EVERY incoming request — regardless of framework. Express, Koa, NestJS, Hapi,
 * fastify's node core and bare `http.createServer` all run their request
 * handling through `http.Server`'s 'request' emit, so a single patch here covers
 * them all with zero user code. Bun's `Bun.serve` (Elysia) does NOT use
 * node:http and needs its own plugin instead.
 *
 * We wrap `emit` rather than the listener so we run OUTSIDE (around) the whole
 * framework handler chain, letting adapters that refine the route name (and the
 * db/http span adapters) attribute their work to the right trace.
 */
export function installHttpServer(client: MetrixWireClient): void {
  patchServerProto(http.Server?.prototype, client)
  patchServerProto(https.Server?.prototype, client)
}

function patchServerProto(proto: any, client: MetrixWireClient): void {
  if (!proto || proto[PATCHED]) return
  const originalEmit = proto.emit
  if (typeof originalEmit !== 'function') return

  proto.emit = function patchedEmit(this: any, event: string, ...args: any[]) {
    if (event !== 'request' || !client.config?.enabled) {
      return originalEmit.apply(this, [event, ...args])
    }
    const req = args[0]
    const res = args[1]
    try {
      return openHttpTrace(client, req, res, () => originalEmit.apply(this, [event, ...args]))
    } catch {
      // If anything about tracing fails, still deliver the request untouched.
      return originalEmit.apply(this, [event, ...args])
    }
  }

  proto[PATCHED] = true
}
