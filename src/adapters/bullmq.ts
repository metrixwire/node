import type { MetrixWireClient } from '../client'
import { runTrace } from '../trace'

const PATCHED = Symbol.for('metrixwire.bullmq.patched')

/**
 * Auto-trace BullMQ jobs. Every worker funnels job execution through
 * `Worker.prototype.processJob`, so wrapping it once runs each job inside its
 * own trace context — db/http/cache spans made by the job attribute correctly,
 * and a thrown job is recorded as an errored trace. No user code required.
 */
export function installBullMQ(bullmq: any, client: MetrixWireClient): void {
  const proto = bullmq?.Worker?.prototype
  if (!proto || proto[PATCHED]) return
  const original = proto.processJob
  if (typeof original !== 'function') return

  proto.processJob = function patchedProcessJob(this: any, job: any, ...rest: any[]) {
    if (!client.config?.enabled || !job) return original.call(this, job, ...rest)
    const queue = job.queueName ?? this?.name ?? 'queue'
    const name = job.name ?? 'job'
    return runTrace(client, { route: `JOB ${queue}:${name}`, method: 'JOB' }, () =>
      original.call(this, job, ...rest),
    )
  }

  proto[PATCHED] = true
}
