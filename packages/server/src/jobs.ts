/**
 * Background work. Handlers are idempotent: a job may run more than once
 * (Queues delivers at least once; the Node runner retries after a crash), so
 * every handler either writes content-addressed objects or makes a conditional
 * state change.
 *
 * Cloudflare: Cloudflare Queues; the Worker's `queue` handler calls runJob.
 * Node: a `jobs` table polled by an in-process runner.
 *
 * Two kinds (v2-scale-review.md S1, S2): bulk jobs can run for minutes or walk
 * a whole collection, and go to their own queue, one per invocation; the rest
 * are small and interactive (a webhook, a file check), and run several at a
 * time so they never wait behind a bulk push, a mirror backfill or a restore.
 */
import { and, asc, eq, lte, or, sql } from 'drizzle-orm'

import * as schema from './db/schema.js'
import type { Db, JobMessage, Jobs, Ports } from './ports.js'

export type JobHandler = (job: JobMessage, ports: Ports) => Promise<void>

/** Job types that go to the bulk queue. Everything else is interactive. */
export const BULK_JOBS: ReadonlySet<string> = new Set([
  'push.commit', // async commits: 100k records and up
  'commit.unit',
  'commit.assemble',
  'push.compact',
  'refs.compact',
  'refs.compactPart',
  'refs.finishCompaction',
  'mirror.version',
  'restore.version',
  'repo.repairLog',
  'reconcile.collection',
  'reconcile.version',
  'reconcile.finish',
  'usage.rebuild',
  'repo.fsck',
])

export const isBulk = (type: string) => BULK_JOBS.has(type)

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

/** Jobs on Cloudflare Queues: interactive and bulk queues (one queue for both if no bulk is bound). */
export class QueueJobs implements Jobs {
  constructor(
    readonly queue: CfQueue,
    readonly bulk: CfQueue = queue,
  ) {}
  #for(type: string) {
    return isBulk(type) ? this.bulk : this.queue
  }
  async enqueue(job: JobMessage, opts?: { delaySeconds?: number }) {
    await this.#for(job.type).send(
      job,
      opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined,
    )
  }
  async enqueueBatch(jobs: JobMessage[]) {
    for (const q of [this.queue, this.bulk]) {
      const mine = jobs.filter((j) => this.#for(j.type) === q)
      // sendBatch takes at most 100 messages.
      for (let i = 0; i < mine.length; i += 100) {
        await q.sendBatch(mine.slice(i, i + 100).map((body) => ({ body })))
      }
      if (this.bulk === this.queue) break
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
    // D1-safe chunking of bound parameters (6 per row, defaults included).
    for (let i = 0; i < jobs.length; i += 15) {
      await this.db
        .insert(schema.jobs)
        .values(
          jobs.slice(i, i + 15).map((job) => ({ type: job.type, payload: job, runAt: new Date() })),
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
    // Interactive jobs first, as their own queue would run them.
    .orderBy(
      sql`CASE WHEN ${schema.jobs.type} IN (${sql.join(
        [...BULK_JOBS].map((t) => sql`${t}`),
        sql`, `,
      )}) THEN 1 ELSE 0 END`,
      asc(schema.jobs.runAt),
    )
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
