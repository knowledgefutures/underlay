/**
 * Storage cleanup runs (planning: v2-storage-cleanup.md): starting them, the
 * jobs that carry them, and what the cron does each tick.
 *
 *   cleanup.internal   step 1 in batches (a manual run; the cron runs one batch a tick)
 *   cleanup.mark       step 2, a job per node budget
 *   cleanup.sweep      step 3, a job per page budget; waits while pushes commit
 *
 * Each job claims the run with a lease and runs only if it carries the run's
 * current `seq`, so a duplicate or late delivery never forks a run in two. A
 * job that dies leaves the lease to expire, and the cron requeues the run. A
 * long job (a mark) writes checkpoints as it goes: its place, its counts so far
 * and a fresh lease, so the page shows progress and a requeued job resumes there.
 */
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import {
  addStats,
  AUTO_SETTING,
  cleanupPaused,
  cleanupConfig,
  emptyStats,
  getRun,
  type RunRow,
  runDir,
  updateRun,
} from './config.js'
import { cleanInternal, deletePrefix } from './internal.js'
import { firstMarkState, markStep, type MarkState } from './mark.js'
import { MarkSet } from './marks.js'
import { sweepStep, type SweepState } from './sweep.js'

const LEASE_MS = 15 * 60 * 1000
const ACTIVE: schema.CleanupStatus[] = ['queued', 'running', 'waiting']
/** A sweep uses a mark at most this old (re-marks grow with its age). */
const MARK_VALID_MS = 3 * 24 * 60 * 60 * 1000
/** A sweep waiting on pushes gives up after this many tries. */
const MAX_WAITS = 60
/** Working objects of runs finished this long ago are deleted. */
const KEEP_WORK_MS = 14 * 24 * 60 * 60 * 1000

export class CleanupRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CleanupRefused'
  }
}

export interface StartOptions {
  trigger: 'manual' | 'schedule'
  dryRun?: boolean
  requestedBy?: string | null
  /** Mark: start a sweep on it when it's done. */
  thenSweep?: boolean
  /** Sweep: the mark to use (default: the latest done one). */
  markRunId?: string
}

/** Start a run of a step. Refused while one of the same kind is in progress. */
export async function startRun(
  ports: Ports,
  step: schema.CleanupStep,
  opts: StartOptions,
): Promise<RunRow> {
  const { db } = ports
  const kinds: schema.CleanupStep[] = step === 'internal' ? ['internal'] : ['mark', 'sweep']
  const [busy] = await db
    .select({ id: schema.cleanupRuns.id, step: schema.cleanupRuns.step })
    .from(schema.cleanupRuns)
    .where(and(inArray(schema.cleanupRuns.step, kinds), inArray(schema.cleanupRuns.status, ACTIVE)))
    .limit(1)
  if (busy) throw new CleanupRefused(`A ${busy.step} run is already in progress`)
  if (step !== 'internal' && (await cleanupPaused(db)))
    throw new CleanupRefused('Marks and sweeps are paused (cleanup_paused)')

  let state: Record<string, unknown> = {}
  let markRunId: string | null = null
  if (step === 'mark') state = { ...firstMarkState(), thenSweep: opts.thenSweep ?? false }
  if (step === 'sweep') {
    const [mark] = await db
      .select()
      .from(schema.cleanupRuns)
      .where(
        and(
          eq(schema.cleanupRuns.step, 'mark'),
          eq(schema.cleanupRuns.status, 'done'),
          opts.markRunId ? eq(schema.cleanupRuns.id, opts.markRunId) : undefined,
        ),
      )
      .orderBy(desc(schema.cleanupRuns.createdAt))
      .limit(1)
    if (!mark?.startedAt)
      throw new CleanupRefused('No finished mark to sweep with: run a mark first')
    if (Date.now() - mark.startedAt.getTime() > MARK_VALID_MS)
      throw new CleanupRefused('The last mark is more than 3 days old: run a new one')
    markRunId = mark.id
    state = { area: 0, cursor: null, markStartedAt: mark.startedAt.getTime() } satisfies SweepState
  }
  const [run] = await db
    .insert(schema.cleanupRuns)
    .values({
      step,
      trigger: opts.trigger,
      dryRun: opts.dryRun ?? false,
      requestedBy: opts.requestedBy ?? null,
      markRunId,
      state,
      stats: emptyStats(),
      seq: 1,
      updatedAt: new Date(),
    })
    .returning()
  await ports.jobs.enqueue({ type: `cleanup.${step}`, runId: run!.id, seq: 1 })
  return run!
}

/** Claim a run for one job: its seq, and no live lease. Null: not this job's turn. */
async function claim(ports: Ports, runId: string, seq: number): Promise<RunRow | 'held' | null> {
  const now = Date.now()
  const [run] = await ports.db
    .update(schema.cleanupRuns)
    .set({ lease: new Date(now) })
    .where(
      and(
        eq(schema.cleanupRuns.id, runId),
        eq(schema.cleanupRuns.seq, seq),
        inArray(schema.cleanupRuns.status, ACTIVE),
        or(
          isNull(schema.cleanupRuns.lease),
          lt(schema.cleanupRuns.lease, new Date(now - LEASE_MS)),
        ),
      ),
    )
    .returning()
  if (run) return run
  const current = await getRun(ports.db, runId)
  return current?.seq === seq && ACTIVE.includes(current.status) ? 'held' : null
}

/** Save a job's place and its counts so far (added to the run's), and renew its lease. */
type Checkpoint = (
  state: Record<string, unknown>,
  stats: schema.CleanupStats,
  marked?: number,
) => Promise<void>

/** Run one job of a run, then hand over to the next (or finish). */
async function runJob(
  ports: Ports,
  job: { runId: string; seq: number; type: string },
  work: (
    run: RunRow,
    checkpoint: Checkpoint,
  ) => Promise<{
    state: Record<string, unknown>
    stats: schema.CleanupStats
    outcome: 'more' | 'done' | 'wait'
    marked?: number
  }>,
): Promise<void> {
  const run = await claim(ports, job.runId, job.seq)
  if (run === 'held') {
    // A duplicate while another delivery works: look again once its lease could have run out.
    await ports.jobs.enqueue({ ...job }, { delaySeconds: 300 })
    return
  }
  if (!run) return
  const { db } = ports
  const next = run.seq + 1
  try {
    if (run.status === 'queued')
      await updateRun(db, run.id, { status: 'running', startedAt: new Date() })
    const started = run.startedAt ?? new Date()
    const base = run.stats ?? emptyStats()
    const checkpoint: Checkpoint = async (state, stats, marked) => {
      const sum = addStats(structuredClone(base), stats)
      if (marked !== undefined) sum.marked = marked
      await db
        .update(schema.cleanupRuns)
        .set({ state, stats: sum, lease: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.cleanupRuns.id, run.id), eq(schema.cleanupRuns.seq, run.seq)))
    }
    const r = await work({ ...run, startedAt: started }, checkpoint)
    const stats = addStats(base, r.stats)
    if (r.marked !== undefined) stats.marked = r.marked
    const waits = r.outcome === 'wait' ? Number(run.state?.waits ?? 0) + 1 : 0
    if (waits > MAX_WAITS) {
      await updateRun(db, run.id, {
        status: 'failed',
        stats,
        error:
          'Pushes kept committing for two hours; nothing more was deleted. Run the sweep again.',
        finishedAt: new Date(),
        lease: null,
      })
      return
    }
    const done = r.outcome === 'done'
    await updateRun(db, run.id, {
      state: { ...r.state, waits },
      stats,
      seq: next,
      lease: null,
      status: done ? 'done' : r.outcome === 'wait' ? 'waiting' : 'running',
      error:
        r.outcome === 'wait'
          ? 'Waiting for pushes to finish committing (or for cleanup to be unpaused)'
          : null,
      ...(done ? { finishedAt: new Date() } : {}),
    })
    if (!done) {
      await ports.jobs.enqueue(
        { type: job.type, runId: run.id, seq: next },
        r.outcome === 'wait' ? { delaySeconds: cleanupConfig.waitSeconds } : undefined,
      )
    } else if (run.step === 'mark' && run.state?.thenSweep) {
      await startRun(ports, 'sweep', {
        trigger: run.trigger,
        dryRun: run.dryRun,
        requestedBy: run.requestedBy,
        markRunId: run.id,
      })
    }
  } catch (err) {
    console.error(`[cleanup] ${run.step} run ${run.id} failed:`, err)
    await updateRun(db, run.id, {
      status: 'failed',
      error: String((err as Error)?.message ?? err).slice(0, 1000),
      finishedAt: new Date(),
      lease: null,
    })
  }
}

registerJob('cleanup.internal', async (job, ports) =>
  runJob(ports, { type: job.type, runId: String(job.runId), seq: Number(job.seq) }, async (run) => {
    const r = await cleanInternal(ports, { dryRun: run.dryRun })
    // A dry run would see the same batch every time: one is the answer.
    return { state: {}, stats: r.stats, outcome: r.done || run.dryRun ? 'done' : 'more' }
  }),
)

registerJob('cleanup.mark', async (job, ports) =>
  runJob(
    ports,
    { type: job.type, runId: String(job.runId), seq: Number(job.seq) },
    async (run, checkpoint) => {
      const internal = ports.stores.internal
      const thenSweep = run.state?.thenSweep ?? false
      const marks = new MarkSet()
      await marks.load(internal, run.id, 'mark')
      const state = (run.state ?? firstMarkState()) as unknown as MarkState
      const r = await markStep(ports, marks, state, async (place, stats) => {
        // Shard first: a place never runs ahead of the marks saved for it.
        await marks.save(internal, run.id, 'mark')
        await checkpoint({ ...place, thenSweep }, stats, marks.size)
      })
      await marks.save(internal, run.id, 'mark')
      return {
        state: { ...r.state, thenSweep },
        stats: r.stats,
        outcome: r.state.phase === 'done' ? 'done' : 'more',
        marked: marks.size,
      }
    },
  ),
)

registerJob('cleanup.sweep', async (job, ports) =>
  runJob(ports, { type: job.type, runId: String(job.runId), seq: Number(job.seq) }, async (run) => {
    const internal = ports.stores.internal
    const marks = new MarkSet()
    await marks.load(internal, run.markRunId!, 'mark')
    await marks.load(internal, run.id, 'remark')
    const state = run.state as unknown as SweepState
    const r = await sweepStep(ports, run.id, marks, state, run.dryRun)
    await marks.save(internal, run.id, 'remark')
    return { state: { ...r.state }, stats: r.stats, outcome: r.outcome, marked: marks.size }
  }),
)

/** UTC midnight today: the cron's step 1 adds to one run row per day. */
const today = () => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** What the maintenance cron does for cleanup, every tick. */
export async function cleanupTick(ports: Ports): Promise<void> {
  const { db } = ports
  // Step 1, one batch. A day's automatic batches share a run row, when they did anything.
  const r = await cleanInternal(ports)
  const did = Object.keys(r.stats.deleted).length > 0 || r.stats.problems.length > 0
  if (did) {
    const [row] = await db
      .select()
      .from(schema.cleanupRuns)
      .where(
        and(
          eq(schema.cleanupRuns.step, 'internal'),
          eq(schema.cleanupRuns.trigger, 'schedule'),
          gt(schema.cleanupRuns.createdAt, today()),
        ),
      )
      .limit(1)
    if (row) {
      await updateRun(db, row.id, {
        stats: addStats(row.stats ?? emptyStats(), r.stats),
        finishedAt: new Date(),
      })
    } else {
      await db.insert(schema.cleanupRuns).values({
        step: 'internal',
        trigger: 'schedule',
        status: 'done',
        stats: r.stats,
        startedAt: new Date(),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
    }
  }

  // Runs whose job chain broke (a message lost after its retries): requeue.
  const stale = await db
    .select()
    .from(schema.cleanupRuns)
    .where(
      and(
        inArray(schema.cleanupRuns.status, ACTIVE),
        lt(schema.cleanupRuns.updatedAt, new Date(Date.now() - 2 * LEASE_MS)),
      ),
    )
  for (const run of stale) {
    await updateRun(db, run.id, {})
    await ports.jobs.enqueue({ type: `cleanup.${run.step}`, runId: run.id, seq: run.seq })
  }

  // Working objects (mark shards) of runs long finished.
  const old = await db
    .select({ id: schema.cleanupRuns.id })
    .from(schema.cleanupRuns)
    .where(
      and(
        inArray(schema.cleanupRuns.step, ['mark', 'sweep']),
        inArray(schema.cleanupRuns.status, ['done', 'failed']),
        lt(schema.cleanupRuns.finishedAt, new Date(Date.now() - KEEP_WORK_MS)),
        sql`${schema.cleanupRuns.state} NOT LIKE '%"workDeleted":true%'`,
      ),
    )
    .limit(5)
  for (const run of old) {
    const gone = await deletePrefix(ports.stores.internal, `${runDir(run.id)}/`, false, 500)
    if (!gone.complete) break
    const current = await getRun(db, run.id)
    await updateRun(db, run.id, { state: { ...current?.state, workDeleted: true } })
  }

  // The weekly automatic mark and sweep, when switched on.
  const [setting] = await db
    .select({ value: schema.instanceSettings.value })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, AUTO_SETTING))
  if (setting?.value !== true) return
  const [last] = await db
    .select({ createdAt: schema.cleanupRuns.createdAt })
    .from(schema.cleanupRuns)
    .where(and(eq(schema.cleanupRuns.step, 'mark'), eq(schema.cleanupRuns.trigger, 'schedule')))
    .orderBy(desc(schema.cleanupRuns.createdAt))
    .limit(1)
  if (last && Date.now() - last.createdAt.getTime() < cleanupConfig.autoEveryMs) return
  await startRun(ports, 'mark', { trigger: 'schedule', thenSweep: true }).catch((err) => {
    if (!(err instanceof CleanupRefused)) throw err
  })
}
