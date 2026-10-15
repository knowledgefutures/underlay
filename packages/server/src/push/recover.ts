/**
 * Recovering commits that stop moving, from the maintenance sweep (every 10
 * minutes). Every step of a commit is a job that may be lost: a queue message
 * past its retries, a Worker that runs out of memory on every attempt. Each
 * step records progress on the session (`progress_at`), so a session that
 * hasn't moved for `stallMs` is nudged: its next step is queued again, and
 * every step is idempotent. A commit that can't finish fails with an error
 * that says why, rather than holding one of the user's session slots forever.
 *
 *   - compaction claims not refreshed for `compactionStaleMs` are queued again
 *     (open sessions too: a lost compaction leaves its runs claimed). A claim is
 *     refreshed when its merge starts and after each piece (compact.ts), and a
 *     piece takes minutes, so a quiet claim is a lost one;
 *   - a commit unit queued `unitLimits.maxAttempts` times fails its commit,
 *     naming the unit's type and range;
 *   - a commit waiting for room in the user's unit windows isn't stalled;
 *   - any other committing session without progress is nudged (push.commit
 *     resumes it from wherever it is), and after `maxStalls` nudges in a row
 *     without progress it fails.
 */
import { and, count, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { topUpUnits, unitLimits } from './parallel.js'
import { transition } from './session.js'

export const recoverConfig = {
  /** A commit step with no progress for this long is stale. */
  stallMs: 30 * 60 * 1000,
  /**
   * A compaction claim not refreshed for this long is lost. Shorter than
   * `stallMs`: a stalled commit waited 30 to 40 minutes on compactions that had
   * quit (staging, 2026-10-15).
   */
  compactionStaleMs: 15 * 60 * 1000,
  /** Nudges in a row without progress before the commit fails. */
  maxStalls: 3,
}

async function fail(ports: Ports, sessionId: string, error: string) {
  await transition(ports, sessionId, 'committing', 'failed', {
    error: { statusCode: 500, error },
    commitPhase: null,
  })
  console.error(`[push] commit of session ${sessionId} failed: ${error}`)
}

export async function recoverCommits(ports: Ports): Promise<void> {
  const { db } = ports
  const staleBefore = new Date(Date.now() - recoverConfig.stallMs)
  const claimStaleBefore = new Date(Date.now() - recoverConfig.compactionStaleMs)

  // Compaction claims that never finished, in sessions that still want them
  // (open, or committing and not yet planned; compact.ts `active`): queue them again.
  const runs = schema.pushRuns
  const s = schema.pushSessions
  const lost = await db
    .selectDistinct({ sessionId: runs.sessionId, seq: runs.mergingInto })
    .from(runs)
    .innerJoin(s, eq(s.id, runs.sessionId))
    .where(
      and(
        isNotNull(runs.mergingInto),
        lt(runs.claimedAt, claimStaleBefore),
        or(eq(s.status, 'open'), and(eq(s.status, 'committing'), isNull(s.commitPlan))),
      ),
    )
    .limit(100)
  for (const c of lost) {
    await db
      .update(runs)
      .set({ claimedAt: new Date() })
      .where(and(eq(runs.sessionId, c.sessionId), eq(runs.mergingInto, c.seq!)))
    await ports.jobs.enqueue({ type: 'push.compact', sessionId: c.sessionId, seq: c.seq })
  }

  const stuck = await db
    .select()
    .from(s)
    .where(
      and(
        eq(s.status, 'committing'),
        or(
          lt(s.progressAt, staleBefore),
          and(isNull(s.progressAt), lt(s.finalizeStartedAt, staleBefore)),
        ),
      ),
    )
    .limit(100)
  for (const session of stuck) {
    if (session.commitPlan) {
      const u = schema.commitUnits
      const pending = await db
        .select()
        .from(u)
        .where(and(eq(u.planId, session.commitPlan), eq(u.status, 'pending')))
      const unitStale = new Date(Date.now() - unitLimits.staleMs)
      const spent = pending.find(
        (x) => x.attempts >= unitLimits.maxAttempts && x.queuedAt && x.queuedAt < unitStale,
      )
      if (spent) {
        const range = `(${spent.after ?? 'start'}, ${spent.through ?? 'end'}]`
        await fail(
          ports,
          session.id,
          `A commit unit failed ${spent.attempts} times (type ${spent.type}, ${spent.set} set, keys ${range}). Push again; if it repeats, report this session.`,
        )
        continue
      }
      // Units still waiting for room in the user's windows: alive, just queued.
      if (pending.some((x) => x.queuedAt === null)) {
        await db.update(s).set({ progressAt: new Date(), stalls: 0 }).where(eq(s.id, session.id))
        await topUpUnits(ports, session.userId)
        continue
      }
    }
    if (session.stalls >= recoverConfig.maxStalls) {
      const where =
        session.commitPhase === 'compacting'
          ? 'compacting its uploads'
          : session.commitPhase === 'planning'
            ? 'planning'
            : session.commitPhase === 'validating'
              ? 'revalidating records against the new schema'
              : session.commitPlan
                ? 'committing in parallel'
                : 'committing'
      await fail(
        ports,
        session.id,
        `The commit stopped making progress while ${where}. Push again; if it repeats, report this session.`,
      )
      continue
    }
    await db
      .update(s)
      .set({ progressAt: new Date(), stalls: session.stalls + 1 })
      .where(and(eq(s.id, session.id), eq(s.status, 'committing')))
    // push.commit picks up from wherever the session is: compaction, the
    // plan's chunks, the units (stale ones go again) or the assembly.
    await ports.jobs.enqueue({ type: 'push.commit', sessionId: session.id })
  }
}

/** A parallel commit's units: how many are done of how many (the status route). */
export async function unitProgress(ports: Ports, planId: string) {
  const u = schema.commitUnits
  const rows = await ports.db
    .select({ status: u.status, gap: u.gap, n: count() })
    .from(u)
    .where(eq(u.planId, planId))
    .groupBy(u.status, u.gap)
  let done = 0
  let total = 0
  for (const r of rows) {
    if (r.status === 'superseded' || r.gap) continue
    total += r.n
    if (r.status === 'done') done += r.n
  }
  return { done, total }
}
