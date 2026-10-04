/**
 * The write fence between writers and the storage sweep (planning:
 * v2-storage-cleanup.md, "The fence").
 *
 * Writers skip keys that already exist (`ifAbsent`), so a push can reuse a node
 * or file a deleted collection left behind. If the sweep deleted that object
 * while the push was in flight, the push would publish a version with a hole.
 *
 *   - A write phase reads the epoch first (`writeFence`), waiting out an open
 *     deletion window.
 *   - The statement that makes its objects reachable (a publish, a files row, a
 *     possession, a tree root on a row) carries `fenceHolds(epoch)`: it matches
 *     only if the epoch is unchanged and no window is open.
 *   - The sweep deletes only inside a window. Opening one bumps the epoch, so a
 *     write phase that began before it can't publish; closing bumps it again, so
 *     one that began during it can't either. The writer then redoes its writes,
 *     which puts back whatever was deleted.
 *   - A window has a deadline. A crashed sweep can't hold writers past it (plus
 *     `slackMs`), and the sweep stops issuing deletes `marginMs` before it, so a
 *     delete would have to hang for minutes to land after writers resume.
 *   - Every time comparison uses the database's clock, so writers and the sweep
 *     agree on whether a window is open whatever their own clocks say.
 */
import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export const fenceConfig = {
  /** How long a writer waits for a window to close before giving up (503). */
  waitMs: 180_000,
  pollMs: 500,
  /** A window counts as open this long past its deadline, for deletes still in flight. */
  slackMs: 120_000,
  /** The sweep issues no delete closer than this to its deadline. */
  marginMs: 15_000,
}

const FENCE_ID = 1

/** A deletion window stayed open longer than a writer waits: retry later. */
export class StorageBusyError extends Error {
  constructor() {
    super('Storage cleanup is deleting objects; try again in a minute')
    this.name = 'StorageBusyError'
  }
}

/** A deletion window opened during this write phase: its writes must be redone. */
export class FenceError extends Error {
  constructor() {
    super('Storage cleanup ran during this write; it has to be redone')
    this.name = 'FenceError'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The database's time, in ms. */
const dbNow = sql<number>`(unixepoch('subsec') * 1000)`

async function readFence(db: Db) {
  const [row] = await db
    .select({
      epoch: schema.storageFence.epoch,
      windowUntil: schema.storageFence.windowUntil,
      windowRunId: schema.storageFence.windowRunId,
      now: dbNow,
    })
    .from(schema.storageFence)
    .where(eq(schema.storageFence.id, FENCE_ID))
    .limit(1)
  if (!row) throw new Error('storage_fence has no row (migration 0015)')
  return { ...row, now: Number(row.now) }
}

/** The epoch to fence a write phase with. Waits while a deletion window is open. */
export async function writeFence(db: Db): Promise<number> {
  const deadline = Date.now() + fenceConfig.waitMs
  for (;;) {
    const row = await readFence(db)
    const until = row.windowUntil?.getTime()
    if (until === undefined || until < row.now - fenceConfig.slackMs) return row.epoch
    if (Date.now() > deadline) throw new StorageBusyError()
    await sleep(fenceConfig.pollMs)
  }
}

/**
 * SQL that holds while `epoch` is current and no window is open: the condition
 * on a statement that makes a write phase's objects reachable.
 */
export function fenceHolds(epoch: number): SQL {
  return sql`EXISTS (SELECT 1 FROM ${schema.storageFence} WHERE ${schema.storageFence.id} = ${FENCE_ID} AND ${schema.storageFence.epoch} = ${epoch} AND (${schema.storageFence.windowUntil} IS NULL OR ${schema.storageFence.windowUntil} < ${dbNow} - ${fenceConfig.slackMs}))`
}

/** After a fenced statement matched nothing: was it the fence (rather than its own condition)? */
export async function fenceMoved(db: Db, epoch: number): Promise<boolean> {
  const [row] = await db
    .select({ ok: sql<number>`1` })
    .from(schema.storageFence)
    .where(sql`${fenceHolds(epoch)}`)
    .limit(1)
  return !row
}

/**
 * Run a write phase under the fence, redoing it (a few times) when a window
 * opened during it. `phase` must be safe to repeat: writes are content-addressed
 * and its reachability statements carry `fenceHolds(epoch)`.
 */
export async function fenced<T>(db: Db, phase: (epoch: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const epoch = await writeFence(db)
    try {
      return await phase(epoch)
    } catch (err) {
      if (!(err instanceof FenceError) || attempt >= 3) throw err
    }
  }
}

// --- The sweep's side -------------------------------------------------------------------

export interface Window {
  runId: string
  /** The epoch while the window is open. */
  epoch: number
  until: number
}

/** Open a deletion window for `ms`, unless one is already open. */
export async function openWindow(db: Db, runId: string, ms: number): Promise<Window | null> {
  const [row] = await db
    .update(schema.storageFence)
    .set({
      epoch: sql`${schema.storageFence.epoch} + 1`,
      windowUntil: sql`${dbNow} + ${ms}`,
      windowRunId: runId,
    })
    .where(
      and(
        eq(schema.storageFence.id, FENCE_ID),
        or(
          isNull(schema.storageFence.windowUntil),
          sql`${schema.storageFence.windowUntil} < ${dbNow} - ${fenceConfig.slackMs}`,
        ),
      ),
    )
    .returning({ epoch: schema.storageFence.epoch, until: schema.storageFence.windowUntil })
  return row ? { runId, epoch: row.epoch, until: row.until!.getTime() } : null
}

/** Whether a delete may still be issued in this window (it's ours, and not near its deadline). */
export async function windowStillOpen(db: Db, w: Window): Promise<boolean> {
  const row = await readFence(db)
  if (row.now > w.until - fenceConfig.marginMs) return false
  return row.epoch === w.epoch && row.windowRunId === w.runId
}

/** Close the window: writers resume, and any that read the epoch during it must redo. */
export async function closeWindow(db: Db, w: Window): Promise<void> {
  await db
    .update(schema.storageFence)
    .set({ epoch: sql`${schema.storageFence.epoch} + 1`, windowUntil: null, windowRunId: null })
    .where(
      and(
        eq(schema.storageFence.id, FENCE_ID),
        // Only this window: a later one (even of the same run) closes itself.
        eq(schema.storageFence.windowRunId, w.runId),
        eq(schema.storageFence.epoch, w.epoch),
      ),
    )
}

/** The fence row, for the admin page. */
export async function fenceState(db: Db) {
  const [row] = await db
    .select()
    .from(schema.storageFence)
    .where(eq(schema.storageFence.id, FENCE_ID))
    .limit(1)
  return row ?? null
}
