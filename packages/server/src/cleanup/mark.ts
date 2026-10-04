/**
 * Cleanup step 2: mark (planning: v2-storage-cleanup.md). A run of jobs, each
 * reading up to `markNodeBudget` tree nodes, then saving what it added as a
 * shard and handing over. Phases, in order:
 *
 *   collections   every version of every live collection on the platform
 *                 location, with its file reference count trees, and the
 *                 collection's cumulative public files tree
 *   tombstones    collections deleted within the grace period, from their logs
 *   possessions   files a live (or recently deleted) collection proved it holds
 *
 * Only the platform location is marked and swept; customer locations never are.
 */
import { openRepo, type Repo } from '@underlay/protocol'
import { and, asc, eq, gt, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { cleanupConfig, emptyStats, problem } from './config.js'
import { Marker, MarkSet } from './marks.js'

export interface MarkState {
  phase: 'collections' | 'tombstones' | 'possessions' | 'done'
  /** The last id handled in the phase. */
  after: string | null
}

export const firstMarkState = (): MarkState => ({ phase: 'collections', after: null })

/**
 * The platform repository without the shared cache: a cached read costs a cache
 * lookup and a cache write besides the bucket read, three subrequests a node.
 */
export async function markRepo(ports: Ports): Promise<Repo> {
  const platform = await ports.stores.forLocation(schema.PLATFORM_LOCATION_ID)
  return openRepo(platform.blobs, { trusted: true })
}

/** Collections deleted after this still keep their objects. */
export const graceCutoff = () => new Date(Date.now() - cleanupConfig.tombstoneGraceMs)

/** A live collection's versions, refs trees and cumulative public files tree. */
export async function markCollection(
  ports: Ports,
  marker: Marker,
  collection: { id: string; publicFilesRoot: string | null },
): Promise<number> {
  const versions = await ports.db
    .select({
      hash: schema.versions.hash,
      publicRefsRoot: schema.versions.publicRefsRoot,
      privateRefsRoot: schema.versions.privateRefsRoot,
    })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collection.id))
    .orderBy(asc(schema.versions.seq))
  for (const v of versions) {
    await marker.version(v.hash)
    await marker.counts(v.publicRefsRoot)
    await marker.counts(v.privateRefsRoot)
  }
  await marker.files(collection.publicFilesRoot)
  return versions.length
}

/**
 * Whether a collection's objects may be in the platform location (the only one
 * swept): its primary is there, or (never expected) it has no primary at all.
 */
async function onPlatform(ports: Ports, collectionId: string): Promise<boolean> {
  const [p] = await ports.db
    .select({ locationId: schema.placements.locationId })
    .from(schema.placements)
    .where(
      and(eq(schema.placements.collectionId, collectionId), eq(schema.placements.role, 'primary')),
    )
    .limit(1)
  return !p || p.locationId === schema.PLATFORM_LOCATION_ID
}

/** Files proved by a collection that is live or deleted within the grace period. */
export const possessionHeld = (cutoff: Date) =>
  sql`(EXISTS (SELECT 1 FROM ${schema.collections} WHERE ${schema.collections.id} = ${schema.fileUploads.collectionId}) OR EXISTS (SELECT 1 FROM ${schema.collectionTombstones} WHERE ${schema.collectionTombstones.collectionId} = ${schema.fileUploads.collectionId} AND ${schema.collectionTombstones.deletedAt} > ${cutoff.getTime()}))`

/**
 * One mark job: continue from `state`, adding to `marks` (loaded from the
 * run's earlier shards), until the phases are done or the budget is spent.
 */
export async function markStep(
  ports: Ports,
  marks: MarkSet,
  state: MarkState,
): Promise<{ state: MarkState; stats: schema.CleanupStats }> {
  const { db } = ports
  const stats = emptyStats()
  const marker = new Marker(await markRepo(ports), marks)
  let handled = 0
  const spent = () =>
    marks.reads >= cleanupConfig.markNodeBudget || handled >= cleanupConfig.markCollections
  const tooMany = () => {
    if (marks.size > cleanupConfig.maxMarked)
      throw new Error(
        `The mark holds over ${cleanupConfig.maxMarked} hashes, more than one pass can; it needs sharding by prefix`,
      )
  }
  const s: MarkState = { ...state }

  while (s.phase === 'collections' && !spent()) {
    const rows = await db
      .select({ id: schema.collections.id, publicFilesRoot: schema.collections.publicFilesRoot })
      .from(schema.collections)
      .where(s.after ? gt(schema.collections.id, s.after) : undefined)
      .orderBy(asc(schema.collections.id))
      .limit(50)
    if (rows.length === 0) Object.assign(s, { phase: 'tombstones', after: null })
    for (const c of rows) {
      if (await onPlatform(ports, c.id)) {
        stats.versions += await markCollection(ports, marker, c)
        stats.collections++
        tooMany()
      }
      s.after = c.id
      handled++
      if (spent()) break
    }
  }

  while (s.phase === 'tombstones' && !spent()) {
    const rows = await db
      .select({
        id: schema.collectionTombstones.collectionId,
        slug: schema.collectionTombstones.slug,
        versions: schema.collectionTombstones.versions,
      })
      .from(schema.collectionTombstones)
      .where(
        and(
          gt(schema.collectionTombstones.deletedAt, graceCutoff()),
          s.after ? gt(schema.collectionTombstones.collectionId, s.after) : undefined,
        ),
      )
      .orderBy(asc(schema.collectionTombstones.collectionId))
      .limit(50)
    if (rows.length === 0) Object.assign(s, { phase: 'possessions', after: null })
    for (const t of rows) {
      // A restored collection has a row again (and its tombstone lifted); a row means live.
      const [live] = await db
        .select({ id: schema.collections.id })
        .from(schema.collections)
        .where(eq(schema.collections.id, t.id))
      if (!live) {
        const r = await marker.fromLog(t.id)
        stats.versions += r.versions
        stats.collections++
        // Versions its log lacks (an append that failed) lose their grace period.
        const why =
          r.problem ??
          (r.versions < t.versions ? `its log has ${r.versions} of ${t.versions} versions` : null)
        if (why)
          problem(stats, `Deleted collection ${t.slug} (${t.id}) is only partly kept: ${why}`)
        tooMany()
      }
      s.after = t.id
      handled++
      if (spent()) break
    }
  }

  while (s.phase === 'possessions' && !spent()) {
    const rows = await db
      .select({ id: schema.fileUploads.id, hash: schema.fileUploads.hash })
      .from(schema.fileUploads)
      .where(
        and(
          eq(schema.fileUploads.status, 'verified'),
          s.after ? gt(schema.fileUploads.id, s.after) : undefined,
          possessionHeld(graceCutoff()),
        ),
      )
      .orderBy(asc(schema.fileUploads.id))
      .limit(500)
    if (rows.length === 0) Object.assign(s, { phase: 'done', after: null })
    for (const r of rows) marks.add('f', r.hash)
    if (rows.length) s.after = rows[rows.length - 1]!.id
    tooMany()
    // Rows aren't node reads, but bound the queries one job sends.
    marks.reads += rows.length / 50
  }

  return { state: s, stats }
}
