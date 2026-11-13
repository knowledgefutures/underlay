/**
 * Running many v3 jobs of one kind at once: a file's verification each, a key range of a
 * merge or a scan each (v3-deploy-plan.md, Phase 2).
 *
 * With a pool (`Ports.pool`: Durable Objects on Workers, worker.ts `V3Pool`), the job that
 * has the work sends it straight to the pool, `concurrency` at a time, and waits: a queue
 * would hand it out at the pace its consumer scales up, which is one at a time for the first
 * half minute. Without one (Node, tests), the jobs go to the queue as before.
 *
 * Each job is idempotent and finishes what it is part of when it is the last (a marker it
 * writes once), so a job that fails here is simply run again: by the queue, or by the cron's
 * recovery of a stalled upload or rebuild.
 */
import { v3 } from '@underlay/protocol'

import type { JobMessage, Ports } from '../ports.js'

export const fanoutConfig = { concurrency: 32 }

export async function fanOut(ports: Ports, jobs: JobMessage[]): Promise<void> {
  const pool = ports.pool
  if (!pool) {
    await ports.jobs.enqueueBatch(jobs)
    return
  }
  const failed: JobMessage[] = []
  await v3.inParallel(
    jobs.map((job) => async () => {
      try {
        await pool(job)
      } catch (err) {
        console.error(`[v3.fanout] ${job.type} failed in the pool, queued instead:`, err)
        failed.push(job)
      }
    }),
    fanoutConfig.concurrency,
  )
  // What failed in the pool goes to the queue, with its retries.
  if (failed.length > 0) await ports.jobs.enqueueBatch(failed)
}
