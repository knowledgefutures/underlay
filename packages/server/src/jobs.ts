/**
 * Background work. Handlers are idempotent: a job may run more than once
 * (Queues delivers at least once; the Node runner retries after a crash), so
 * every handler either writes content-addressed objects or makes a conditional
 * state change.
 *
 * Cloudflare: Cloudflare Queues; the Worker's `queue` handler calls runJob.
 * Node: a `jobs` table polled by an in-process runner.
 */
import { and, asc, eq, lte, or, sql } from 'drizzle-orm'

import * as schema from './db/schema.js'
import type { Db, JobMessage, Jobs, Ports } from './ports.js'

export type JobHandler = (job: JobMessage, ports: Ports) => Promise<void>

const handlers = new Map<string, JobHandler>()

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler)
}

export async function runJob(job: JobMessage, ports: Ports): Promise<void> {
  const handler = handlers.get(job.type)
  if (!handler) throw new Error(`No handler for job type ${job.type}`)
  await handler(job, ports)
}

// --- Cloudflare Queues --------------------------------------------------------------

interface CfQueue {
  send(body: unknown, opts?: { delaySeconds?: number }): Promise<void>
  sendBatch(messages: { body: unknown; delaySeconds?: number }[]): Promise<void>
}

export class QueueJobs implements Jobs {
  constructor(readonly queue: CfQueue) {}
  async enqueue(job: JobMessage, opts?: { delaySeconds?: number }) {
    await this.queue.send(job, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined)
  }
  async enqueueBatch(jobs: JobMessage[]) {
    // sendBatch takes at most 100 messages.
    for (let i = 0; i < jobs.length; i += 100) {
      await this.queue.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })))
    }
  }
}

// --- Node: SQLite jobs table -----------------------------------------------------------

const LOCK_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 8

export class SqliteJobs implements Jobs {
  constructor(readonly db: Db) {}
  async enqueue(job: JobMessage, opts?: { delaySeconds?: number }) {
    await this.db.insert(schema.jobs).values({
      type: job.type,
      payload: job,
      runAt: new Date(Date.now() + (opts?.delaySeconds ?? 0) * 1000),
    })
  }
  async enqueueBatch(jobs: JobMessage[]) {
    // D1-safe chunking of bound parameters (3 per row).
    for (let i = 0; i < jobs.length; i += 30) {
      await this.db
        .insert(schema.jobs)
        .values(
          jobs.slice(i, i + 30).map((job) => ({ type: job.type, payload: job, runAt: new Date() })),
        )
    }
  }
}

/** Claim one ready job, atomically: a single UPDATE … RETURNING. */
async function claim(db: Db): Promise<typeof schema.jobs.$inferSelect | null> {
  const now = Date.now()
  const ready = db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      or(
        and(eq(schema.jobs.status, 'queued'), lte(schema.jobs.runAt, new Date(now))),
        and(eq(schema.jobs.status, 'running'), lte(schema.jobs.lockedUntil, new Date(now))),
      ),
    )
    .orderBy(asc(schema.jobs.runAt))
    .limit(1)
  const [job] = await db
    .update(schema.jobs)
    .set({
      status: 'running',
      lockedUntil: new Date(now + LOCK_MS),
      attempts: sql`${schema.jobs.attempts} + 1`,
    })
    .where(eq(schema.jobs.id, sql`(${ready})`))
    .returning()
  return job ?? null
}

/**
 * Run ready jobs until none are left. Returns how many ran. The Node entry calls
 * this on an interval and right after enqueueing; tests call it directly.
 */
export async function drainSqliteJobs(ports: Ports, opts: { max?: number } = {}): Promise<number> {
  let ran = 0
  for (;;) {
    if (opts.max !== undefined && ran >= opts.max) return ran
    const job = await claim(ports.db)
    if (!job) return ran
    ran++
    try {
      await runJob(job.payload as JobMessage, ports)
      await ports.db.delete(schema.jobs).where(eq(schema.jobs.id, job.id))
    } catch (err) {
      const failed = job.attempts >= MAX_ATTEMPTS
      const backoff = Math.min(3600, 2 ** job.attempts) * 1000
      await ports.db
        .update(schema.jobs)
        .set({
          status: failed ? 'failed' : 'queued',
          runAt: new Date(Date.now() + backoff),
          lockedUntil: null,
          error: String((err as Error)?.stack ?? err).slice(0, 4000),
        })
        .where(eq(schema.jobs.id, job.id))
      console.error(`[jobs] ${job.type} attempt ${job.attempts} failed:`, err)
    }
  }
}
