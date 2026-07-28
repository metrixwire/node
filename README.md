# @metrixwire/node

Zero-config APM SDK for **Node.js & Bun**. Call `init()` once — every request, database query, cache op, outbound HTTP call and queue job is instrumented automatically. There is no manual span API and no middleware to wire up. Non-blocking: if the MetrixWire endpoint is down, your app keeps running normally.

## Installation

```bash
npm install @metrixwire/node
```

## Usage

```ts
import { MetrixWire } from '@metrixwire/node'

MetrixWire.init({ apiKey: process.env.METRIXWIRE_KEY })
```

That's it. Do this once, as early as possible in your process (before your server starts). Every HTTP request becomes a **trace**, and every query / HTTP call / cache op within it becomes a **span**.

## How the automatic tracing works

MetrixWire patches Node's `http.Server` at the `request` event, so a trace is opened for **every incoming request across every framework** — no middleware, no per-route setup:

| Framework | Traced automatically | Notes |
|---|---|---|
| **Express** | ✅ | Route pattern (`/users/:id`) detected automatically. |
| **Koa · NestJS · Hapi · raw `http`** | ✅ | Works out of the box. |
| **Fastify** | ✅ | Register `fastifyPlugin` (below) for the matched route name. |
| **Elysia (Bun)** | ✅ | Requires `elysiaPlugin` — Bun's `Bun.serve` bypasses `node:http`. |

### Optional framework plugins (route names only)

The trace is already opened automatically; these just refine the route to the matched pattern and record handler errors.

```ts
// Fastify
import { fastifyPlugin } from '@metrixwire/node'
app.register(fastifyPlugin)

// Koa (register first)
import { koaMiddleware } from '@metrixwire/node'
app.use(koaMiddleware())

// Elysia (Bun) — REQUIRED, opens the trace since Bun.serve isn't node:http
import { elysiaPlugin } from '@metrixwire/node'
const app = new Elysia().use(elysiaPlugin())
```

## Automatically instrumented libraries

| Library | How |
|---|---|
| **node-postgres (`pg`)** | patched at the driver level |
| **Drizzle · Knex · Sequelize · TypeORM** (via `pg`/`mysql2`) | automatic, since they run on those drivers |
| **mysql2** | patches `Connection.prototype.query`/`execute` |
| **ioredis** | cache spans (hit/miss) for the slow-cache detector |
| **BullMQ** | each processed job becomes its own trace |
| **fetch · axios · got · node-fetch** | patches global `fetch` + `http`/`https` |
| **Prisma** | via `instrumentPrisma()` (it has its own query engine) |

### Prisma

Prisma runs its own query engine, so it's the one library that needs an explicit wrap:

```ts
import { PrismaClient } from '@prisma/client'
import { instrumentPrisma } from '@metrixwire/node'

const prisma = instrumentPrisma(new PrismaClient())
// use `prisma` as usual
```

## `init` options

```ts
MetrixWire.init({
  apiKey: 'mw_...',                        // required
  endpoint: 'http://localhost:3000/ingest', // default
  flushIntervalMs: 5000,                    // how often batches are sent
  enabled: true,                            // set to false to disable entirely
  timeoutMs: 3000,                          // send timeout (short, non-blocking)
  maxBatch: 20,                             // flush immediately once this many are queued
  captureSource: true,                      // capture the file:line a span originated from
})
```

## Non-blocking behavior

- Traces are sent in batches, off the request path, with a short timeout.
- **All** transport errors are swallowed — instrumentation never throws into your app.
- A final flush runs on `beforeExit`; you can also `await MetrixWire.flush()` before a short-lived process exits.
