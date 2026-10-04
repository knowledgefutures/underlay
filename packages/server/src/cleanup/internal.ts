/**
 * Cleanup step 1: platform-internal objects, by their rows (planning:
 * v2-storage-cleanup.md). Runs a bounded batch on every cron tick; a manual run
 * repeats batches until nothing is left.
 *
 *   - push sessions committed, failed or expired, idle past the grace period:
 *     everything under sessions/<id>/, and their run and commit-unit rows;
 *   - reference-log scratch (sessions/refs-<versionId>/) once the version is
 *     indexed or gone;
 *   - direct uploads still pending past the grace period: the multipart upload
 *     aborted, the staging object deleted, the row failed;
 *   - fsck reports of collections that no longer exist.
 *
 * Nothing here is reachable from a version, so it needs no fence.
 */
import type { Store } from '@underlay/protocol'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'

import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { cleanupConfig, count, emptyStats, problem } from './config.js'

const TERMINAL: schema.SessionStatus[] = ['committed', 'failed', 'expired']

/**
 * Delete everything under a prefix, up to `budget` objects; returns objects and
 * bytes (counted, not deleted, when dry) and whether it got to the end.
 */
export async function deletePrefix(
  store: Store,
  prefix: string,
  dryRun: boolean,
  budget = Infinity,
): Promise<{ objects: number; bytes: number; complete: boolean }> {
  let objects = 0
  let bytes = 0
  let cursor: string | undefined
  for (;;) {
    // Deleting moves the listing's start, so a real run lists from the top each time.
    if (objects >= budget) return { objects, bytes, complete: false }
    const page = await store.list(prefix, dryRun ? cursor : undefined)
    const keys = page.keys.slice(0, Math.max(0, budget - objects))
    objects += keys.length
    keys.forEach((_, i) => (bytes += page.info?.[i]?.size ?? 0))
    if (!dryRun) await Promise.all(keys.map((k) => store.delete(k)))
    if (keys.length < page.keys.length) return { objects, bytes, complete: false }
    if (!page.cursor) break
    cursor = page.cursor
  }
  return { objects, bytes, complete: true }
}

/** One batch of step 1. `done` is false while more is left than a batch takes. */
export async function cleanInternal(
  ports: Ports,
  opts: { dryRun?: boolean; batch?: number } = {},
): Promise<{ stats: schema.CleanupStats; done: boolean }> {
  const { db } = ports
  const dryRun = opts.dryRun ?? false
  const batch = opts.batch ?? cleanupConfig.internalBatch
  const internal = ports.stores.internal
  const stats = emptyStats()
  const now = Date.now()
  let more = false
  let budget = cleanupConfig.internalObjects

  // Push sessions.
  const sessions = await db
    .select({ id: schema.pushSessions.id })
    .from(schema.pushSessions)
    .where(
      and(
        isNull(schema.pushSessions.cleanedAt),
        inArray(schema.pushSessions.status, TERMINAL),
        lt(schema.pushSessions.expiresAt, new Date(now - cleanupConfig.sessionGraceMs)),
      ),
    )
    .limit(batch + 1)
  if (sessions.length > batch) more = true
  for (const s of sessions.slice(0, batch)) {
    if (budget <= 0) {
      more = true
      break
    }
    stats.scanned++
    const gone = await deletePrefix(internal, `sessions/${s.id}/`, dryRun, budget)
    budget -= gone.objects
    count(stats, 'sessions', gone.bytes, gone.objects)
    // A session bigger than what's left of the budget finishes next time.
    if (!gone.complete) more = true
    if (dryRun || !gone.complete) continue
    const [runs, units] = await Promise.all([
      db
        .delete(schema.pushRuns)
        .where(eq(schema.pushRuns.sessionId, s.id))
        .returning({ seq: schema.pushRuns.seq }),
      db
        .delete(schema.commitUnits)
        .where(eq(schema.commitUnits.sessionId, s.id))
        .returning({ id: schema.commitUnits.id }),
    ])
    stats.rows += runs.length + units.length
    await db
      .update(schema.pushSessions)
      .set({ cleanedAt: new Date() })
      .where(eq(schema.pushSessions.id, s.id))
  }

  // Reference-log scratch: one directory per version being indexed.
  const scratch = await internal.list('sessions/refs-')
  const versionIds = [
    ...new Set(scratch.keys.map((k) => k.slice('sessions/refs-'.length).split('/')[0]!)),
  ]
  if (scratch.cursor) more = true
  for (const part of chunks(versionIds)) {
    const rows = await db
      .select({ id: schema.versions.id, indexed: schema.versions.refsIndexed })
      .from(schema.versions)
      .where(inArray(schema.versions.id, part))
    const indexing = new Set(rows.filter((r) => !r.indexed).map((r) => r.id))
    for (const v of part) {
      if (indexing.has(v) || budget <= 0) continue
      stats.scanned++
      const gone = await deletePrefix(internal, `sessions/refs-${v}/`, dryRun, budget)
      budget -= gone.objects
      if (!gone.complete) more = true
      count(stats, 'refs scratch', gone.bytes, gone.objects)
    }
  }

  // Direct uploads nobody finished.
  const abandoned = await db
    .select()
    .from(schema.fileUploads)
    .where(
      and(
        eq(schema.fileUploads.status, 'pending'),
        lt(schema.fileUploads.createdAt, new Date(now - cleanupConfig.uploadGraceMs)),
      ),
    )
    .limit(batch + 1)
  if (abandoned.length > batch) more = true
  const blobs = ports.stores.fileBytes
  for (const u of abandoned.slice(0, batch)) {
    stats.scanned++
    const head = await blobs.head(u.storageKey).catch(() => null)
    count(stats, 'uploads', head?.size ?? 0, head ? 1 : 0)
    if (dryRun) continue
    if (u.multipartUploadId) {
      await blobs.presigner
        .abortMultipart(u.storageKey, u.multipartUploadId)
        .catch((err) => problem(stats, `abort upload ${u.id}: ${(err as Error).message}`))
    }
    await blobs.delete(u.storageKey)
    await db
      .update(schema.fileUploads)
      .set({ status: 'failed', error: 'Abandoned: the upload was never completed' })
      .where(and(eq(schema.fileUploads.id, u.id), eq(schema.fileUploads.status, 'pending')))
  }
  const [stuck] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.fileUploads)
    .where(
      and(
        eq(schema.fileUploads.status, 'verifying'),
        lt(schema.fileUploads.createdAt, new Date(now - cleanupConfig.uploadGraceMs)),
      ),
    )
  if (stuck?.n) problem(stats, `${stuck.n} uploads have been verifying for over a day`)

  // fsck reports of collections that are gone.
  const reports = await internal.list('fsck/')
  if (reports.cursor) more = true
  const ids = reports.keys.map((k) => k.slice('fsck/'.length).replace(/\.json$/, ''))
  for (const part of chunks(ids)) {
    const live = new Set(
      (
        await db
          .select({ id: schema.collections.id })
          .from(schema.collections)
          .where(inArray(schema.collections.id, part))
      ).map((r) => r.id),
    )
    for (const id of part) {
      if (live.has(id)) continue
      stats.scanned++
      const i = ids.indexOf(id)
      count(stats, 'fsck reports', reports.info?.[i]?.size ?? 0)
      if (!dryRun) await internal.delete(`fsck/${id}.json`)
    }
  }

  return { stats, done: !more }
}
