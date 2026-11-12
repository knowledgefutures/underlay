/**
 * Forks and deletion of v3 collections (v3-deploy-plan.md, Phase 3).
 *
 * A fork copies its parent's commits up to the fork point and its layout (the library's
 * `forkCollection`): it names the same sorted-record-files, stored once, and keeps the
 * parent's history, so its versions are the parent's, numbered the same. D1 gets a copy of
 * the parent's version rows up to that point, its schema usage, and the `forks` row.
 *
 * A deleted collection's own objects (description, commits, layouts) are deleted once its
 * tombstone's grace is over; the sweep then frees the files nothing else lists.
 */
import { v3 } from '@underlay/protocol'
import { and, asc, eq, getTableColumns, gt, inArray, isNull, lte, sql } from 'drizzle-orm'

import { graceCutoff } from '../cleanup/mark.js'
import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { syncCatalog } from './catalog.js'

type CollectionRow = typeof schema.collections.$inferSelect
type VersionRow = typeof schema.versions.$inferSelect

/** Fork `parent` at `version` into `fork`, a new, empty v3 collection's row. */
export async function forkV3(
  ports: Ports,
  parent: CollectionRow,
  version: VersionRow,
  fork: CollectionRow,
): Promise<VersionRow> {
  const db = ports.db
  const at = version.seq
  // The parent's rows up to the fork point, written if a commit's D1 write was lost.
  await syncCatalog(ports, parent.id)
  try {
    await v3.forkCollection(ports.stores.v3, parent.id, fork.id, { at })
  } catch (err) {
    await db.delete(schema.collections).where(eq(schema.collections.id, fork.id))
    throw err
  }
  const lit = <T>(value: unknown) => sql<T>`${value}`
  const V = schema.versions
  const U = schema.schemaUsage
  // Every column as the parent's row has it (in the table's order, as INSERT … SELECT
  // needs), but a new id and the fork's collection.
  const rows = db
    .select({
      ...getTableColumns(V),
      id: sql<string>`lower(hex(randomblob(16)))`.as('id'),
      collectionId: lit<string>(fork.id).as('collection_id'),
    })
    .from(V)
    .where(and(eq(V.collectionId, parent.id), lte(V.seq, at)))
  const usage = db
    .select({
      ...getTableColumns(U),
      collectionId: lit<string>(fork.id).as('collection_id'),
      toSeq: sql<number | null>`CASE WHEN ${U.toSeq} > ${at} THEN NULL ELSE ${U.toSeq} END`.as(
        'to_seq',
      ),
    })
    .from(U)
    .where(and(eq(U.collectionId, parent.id), lte(U.fromSeq, at)))
  const forkRows = sql`(SELECT ${V.id} FROM ${V} WHERE ${V.collectionId} = ${fork.id}`
  await db.batch([
    db.insert(V).select(rows as never),
    db.insert(U).select(usage as never),
    db
      .update(schema.collections)
      .set({
        headVersionId: sql`${forkRows} AND ${V.seq} = ${at})`,
        versionCount: sql`(SELECT count(*) FROM ${V} WHERE ${V.collectionId} = ${fork.id})`,
        historyBytes: sql`(SELECT coalesce(sum(${V.totalBytes}), 0) FROM ${V} WHERE ${V.collectionId} = ${fork.id})`,
        summary: parent.summary,
        lastPushAt: parent.lastPushAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.collections.id, fork.id)),
    db.insert(schema.forks).values({
      childCollectionId: fork.id,
      parentCollectionId: parent.id,
      parentSeq: at,
      sets: 'public',
    }),
  ] as never)
  const [head] = await db
    .select()
    .from(V)
    .where(and(eq(V.collectionId, fork.id), eq(V.seq, at)))
  if (!head) throw new Error(`The fork of ${parent.id} has no version ${at}`)
  return head
}

/** Deleted collections dropped a job at a time. */
const DROPS_PER_JOB = 50

/**
 * Delete the objects of v3 collections whose tombstones' grace is over. Returns how many
 * collections it dropped.
 */
export async function dropDeletedV3(ports: Ports): Promise<number> {
  const T = schema.collectionTombstones
  const due = await ports.db
    .select({ id: T.collectionId })
    .from(T)
    .where(
      and(eq(T.recordLayout, 'v3'), isNull(T.recordsDroppedAt), lte(T.deletedAt, graceCutoff())),
    )
    .orderBy(asc(T.collectionId))
    .limit(DROPS_PER_JOB)
  for (const { id } of due) {
    // A row means it is live again under the same id: leave it.
    const [row] = await ports.db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(eq(schema.collections.id, id))
    if (!row) await v3.deleteCollection(ports.stores.v3, id)
    await ports.db.update(T).set({ recordsDroppedAt: new Date() }).where(eq(T.collectionId, id))
  }
  return due.length
}

/**
 * Drop v3 collections whose D1 row is gone and whose tombstone, if any, is past its grace:
 * a collection converted but deleted before it was flipped (its tombstone names its v2
 * layout), or anything else left behind. The sweep walks every v3 collection, so it passes
 * their ids here. Returns how many it dropped.
 */
export async function dropOrphans(ports: Ports, collectionIds: string[]): Promise<number> {
  const db = ports.db
  const T = schema.collectionTombstones
  let dropped = 0
  for (const part of chunks(collectionIds, 90)) {
    const live = new Set(
      (
        await db
          .select({ id: schema.collections.id })
          .from(schema.collections)
          .where(inArray(schema.collections.id, part))
      ).map((r) => r.id),
    )
    const grace = new Set(
      (
        await db
          .select({ id: T.collectionId })
          .from(T)
          .where(and(inArray(T.collectionId, part), gt(T.deletedAt, graceCutoff())))
      ).map((r) => r.id),
    )
    for (const id of part) {
      if (live.has(id) || grace.has(id)) continue
      await v3.deleteCollection(ports.stores.v3, id)
      dropped++
    }
  }
  return dropped
}
