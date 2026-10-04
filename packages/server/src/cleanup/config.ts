/**
 * Storage cleanup settings, and the run rows every step reports into
 * (planning: v2-storage-cleanup.md).
 */
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export const cleanupConfig = {
  /** A finished push session keeps its objects this long after its last activity. */
  sessionGraceMs: DAY,
  /** A direct upload still pending after this is abandoned. */
  uploadGraceMs: DAY,
  /** Internal objects with no row (a crash between write and insert) are orphans past this age. */
  orphanAgeMs: 2 * DAY,
  /** A deleted collection's objects stay this long, so a mistaken delete can be recovered by hand. */
  tombstoneGraceMs: 7 * DAY,
  /** Sessions, uploads and reports one cron tick cleans, at most. */
  internalBatch: 40,
  /** Tree nodes one mark job reads before it saves and hands over (checked between collections). */
  markNodeBudget: 20_000,
  /** Hashes a mark may hold in memory; past it the run fails rather than run out (shard by prefix then). */
  maxMarked: 3_000_000,
  /** Listing pages one sweep job reads. */
  sweepPages: 40,
  /** How long a deletion window stays open, and the objects one window deletes at most. */
  windowMs: 30_000,
  windowObjects: 400,
  deleteConcurrency: 16,
  /** A push committing for less than this holds up a deletion window (it would fail otherwise). */
  committingHoldMs: 6 * HOUR,
  /** How long a sweep waits for pushes to finish before it tries again. */
  waitSeconds: 120,
  /** The automatic mark and sweep (when switched on), at most this often. */
  autoEveryMs: 7 * DAY,
}

/** The instance setting that switches the weekly automatic mark and sweep on. */
export const AUTO_SETTING = 'cleanup_auto'

export function emptyStats(): schema.CleanupStats {
  return {
    deleted: {},
    scanned: 0,
    unknown: 0,
    marked: 0,
    versions: 0,
    collections: 0,
    rows: 0,
    windows: 0,
    problems: [],
  }
}

export function count(stats: schema.CleanupStats, kind: string, bytes: number, objects = 1) {
  const c = (stats.deleted[kind] ??= { objects: 0, bytes: 0 })
  c.objects += objects
  c.bytes += bytes
}

export function problem(stats: schema.CleanupStats, msg: string) {
  if (stats.problems.length < 20) stats.problems.push(msg.slice(0, 300))
}

/** Add `b` into `a` (a run's jobs each report what they did). */
export function addStats(a: schema.CleanupStats, b: schema.CleanupStats): schema.CleanupStats {
  for (const [k, c] of Object.entries(b.deleted)) count(a, k, c.bytes, c.objects)
  a.scanned += b.scanned
  a.unknown += b.unknown
  a.marked += b.marked
  a.versions += b.versions
  a.collections += b.collections
  a.rows += b.rows
  a.windows += b.windows
  for (const p of b.problems) problem(a, p)
  return a
}

export type RunRow = typeof schema.cleanupRuns.$inferSelect

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const [r] = await db.select().from(schema.cleanupRuns).where(eq(schema.cleanupRuns.id, id))
  return r ?? null
}

export async function updateRun(
  db: Db,
  id: string,
  set: Partial<typeof schema.cleanupRuns.$inferInsert>,
): Promise<void> {
  await db
    .update(schema.cleanupRuns)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(schema.cleanupRuns.id, id))
}

/** Where a run keeps its working objects (mark shards), in the internal area. */
export const runDir = (runId: string) => `cleanup/${runId}`
