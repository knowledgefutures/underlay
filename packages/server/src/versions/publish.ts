/**
 * Publish: make a built version visible by moving the collection's head, with
 * compare-and-swap (edge-redesign.md, Commit step 5).
 *
 * D1 has no interactive transactions, so the CAS is one atomic batch whose
 * statements all carry the condition in SQL:
 *   1. insert the version row only if the head is still the base;
 *   2. move the head only if it is still the base and the row from 1 exists;
 *   3. close and open schema_usage rows only if the row from 1 exists;
 *   4. for a fork's first version, the forks row, only if the row from 1 exists.
 * If another commit won, 1 inserts nothing and the rest match nothing; the
 * caller sees that by reading the head back. Everything the version points to is
 * already in the repository, so there is never a half-built version.
 *
 * 1 also holds only while the storage fence the caller's write phase began
 * under is unchanged (cleanup/fence.ts): if a deletion window opened since, an
 * object the version reuses may be gone, so the caller redoes its writes.
 */
import { type SetName } from '@underlay/protocol'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { fenceHolds, fenceMoved } from '../cleanup/fence.js'
import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export interface NewVersionRow {
  id: string
  collectionId: string
  seq: number
  semver: string
  major: number
  minor: number
  patch: number
  hash: string
  baseSemver: string | null
  message: string | null
  pushedBy: string | null
  appId: string | null
  actorId: string | null
  recordCount: number
  publicRecordCount: number
  fileCount: number
  totalBytes: number
  publicFileCount: number
  publicTotalBytes: number
  typeCounts: Record<string, number>
  publicTypeCounts: Record<string, number>
  hasPrivate: boolean
  publicRefsRoot: string | null
  privateRefsRoot: string | null
  changes: { added: number; removed: number; updated: number }
  /** Migration only: the v1 version's time and format 1 hashes. */
  createdAt?: Date
  legacyHash?: string | null
  legacyPublicHash?: string | null
}

export interface SchemaUsageChange {
  set: SetName
  typeSlug: string
  /** The schema the type now uses in the set, or null when it left the set. */
  schemaHash: string | null
  /** Whether a usage row is currently open (the type was in the set at the base). */
  wasOpen: boolean
}

export interface PublishInput {
  version: NewVersionRow
  /** The storage fence epoch read before the version's objects were written. */
  fence: number
  baseVersionId: string | null
  collectionUpdate: {
    publicFilesRoot: string | null
    summary: schema.CollectionSummary | null
  }
  schemaHashes: string[]
  usage: SchemaUsageChange[]
  /** A fork's first version: where it came from and which sets it carried. */
  fork?: {
    parentCollectionId: string
    parentSeq: number
    sets: 'public' | 'public+private'
  }
}

export async function publishVersion(
  db: Db,
  p: PublishInput,
): Promise<{ ok: boolean; headVersionId: string | null; fenced: boolean }> {
  const v = p.version
  const now = Date.now()
  const createdAt = v.createdAt?.getTime() ?? now
  // Literal values for INSERT … SELECT. Raw SQL bypasses column mapping, so JSON
  // and booleans are given in their stored form.
  const lit = <T>(value: unknown) => sql<T>`${value}`
  const versionExists = sql`EXISTS (SELECT 1 FROM ${schema.versions} WHERE ${schema.versions.id} = ${v.id})`
  const headIsBase = and(
    eq(schema.collections.id, v.collectionId),
    sql`${schema.collections.headVersionId} IS ${p.baseVersionId}`,
  )

  // Only query builders can go in a D1 batch (raw db.run() can't), so the
  // conditions are INSERT … SELECT from the row they depend on, and UPDATE … WHERE.
  const statements = [
    // 1. The version row, only if the head is still the base: selected from the
    //    collection row, filtered by that condition.
    db.insert(schema.versions).select(
      db
        .select({
          id: lit<string>(v.id).as('id'),
          collectionId: lit<string>(v.collectionId).as('collection_id'),
          seq: lit<number>(v.seq).as('seq'),
          semver: lit<string>(v.semver).as('semver'),
          major: lit<number>(v.major).as('major'),
          minor: lit<number>(v.minor).as('minor'),
          patch: lit<number>(v.patch).as('patch'),
          hash: lit<string>(v.hash).as('hash'),
          legacyHash: lit<string | null>(v.legacyHash ?? null).as('legacy_hash'),
          legacyPublicHash: lit<string | null>(v.legacyPublicHash ?? null).as('legacy_public_hash'),
          baseSemver: lit<string | null>(v.baseSemver).as('base_semver'),
          message: lit<string | null>(v.message).as('message'),
          pushedBy: lit<string | null>(v.pushedBy).as('pushed_by'),
          appId: lit<string | null>(v.appId).as('app_id'),
          actorId: lit<string | null>(v.actorId).as('actor_id'),
          signature: lit<string | null>(null).as('signature'),
          recordCount: lit<number>(v.recordCount).as('record_count'),
          publicRecordCount: lit<number>(v.publicRecordCount).as('public_record_count'),
          fileCount: lit<number>(v.fileCount).as('file_count'),
          totalBytes: lit<number>(v.totalBytes).as('total_bytes'),
          publicFileCount: lit<number>(v.publicFileCount).as('public_file_count'),
          publicTotalBytes: lit<number>(v.publicTotalBytes).as('public_total_bytes'),
          typeCounts: lit<string>(JSON.stringify(v.typeCounts)).as('type_counts'),
          publicTypeCounts: lit<string>(JSON.stringify(v.publicTypeCounts)).as(
            'public_type_counts',
          ),
          hasPrivate: lit<number>(v.hasPrivate ? 1 : 0).as('has_private'),
          publicRefsRoot: lit<string | null>(v.publicRefsRoot).as('public_refs_root'),
          privateRefsRoot: lit<string | null>(v.privateRefsRoot).as('private_refs_root'),
          refsIndexed: lit<number>(0).as('refs_indexed'),
          refEvents: lit<number | null>(null).as('ref_events'),
          refBytes: lit<number | null>(null).as('ref_bytes'),
          reconciledAt: lit<number | null>(null).as('reconciled_at'),
          reconcileReport: lit<string | null>(null).as('reconcile_report'),
          changes: lit<string>(JSON.stringify(v.changes)).as('changes'),
          createdAt: lit<number>(createdAt).as('created_at'),
          publishedAt: lit<number>(now).as('published_at'),
        })
        .from(schema.collections)
        .where(and(headIsBase, fenceHolds(p.fence))) as never,
    ),
    // 2. Move the head, only if it is still the base and the row from 1 exists.
    db
      .update(schema.collections)
      .set({
        headVersionId: v.id,
        updatedAt: new Date(now),
        publicFilesRoot: p.collectionUpdate.publicFilesRoot,
        summary: p.collectionUpdate.summary,
      })
      .where(and(headIsBase, versionExists)),
    ...p.schemaHashes.map((h) =>
      db.insert(schema.schemas).values({ hash: h }).onConflictDoNothing(),
    ),
    // 3. Schema usage, only if the row from 1 exists.
    ...p.usage.flatMap((u) => {
      const out = []
      if (u.wasOpen) {
        out.push(
          db
            .update(schema.schemaUsage)
            .set({ toSeq: v.seq })
            .where(
              and(
                eq(schema.schemaUsage.collectionId, v.collectionId),
                eq(schema.schemaUsage.typeSlug, u.typeSlug),
                eq(schema.schemaUsage.set, u.set),
                isNull(schema.schemaUsage.toSeq),
                versionExists,
              ),
            ),
        )
      }
      if (u.schemaHash !== null) {
        out.push(
          db.insert(schema.schemaUsage).select(
            db
              .select({
                schemaHash: lit<string>(u.schemaHash).as('schema_hash'),
                collectionId: lit<string>(v.collectionId).as('collection_id'),
                typeSlug: lit<string>(u.typeSlug).as('type_slug'),
                set: lit<string>(u.set).as('set'),
                fromSeq: lit<number>(v.seq).as('from_seq'),
                toSeq: lit<number | null>(null).as('to_seq'),
              })
              .from(schema.versions)
              .where(eq(schema.versions.id, v.id)) as never,
          ),
        )
      }
      return out
    }),
    // 4. The fork row, only if the row from 1 exists.
    ...(p.fork
      ? [
          db.insert(schema.forks).select(
            db
              .select({
                childCollectionId: lit<string>(v.collectionId).as('child_collection_id'),
                parentCollectionId: lit<string>(p.fork.parentCollectionId).as(
                  'parent_collection_id',
                ),
                parentSeq: lit<number>(p.fork.parentSeq).as('parent_seq'),
                sets: lit<string>(p.fork.sets).as('sets'),
                createdAt: lit<number>(now).as('created_at'),
              })
              .from(schema.versions)
              .where(eq(schema.versions.id, v.id)) as never,
          ),
        ]
      : []),
  ]
  await db.batch(statements as unknown as Parameters<Db['batch']>[0])

  const [row] = await db
    .select({ head: schema.collections.headVersionId })
    .from(schema.collections)
    .where(eq(schema.collections.id, v.collectionId))
    .limit(1)
  const ok = row?.head === v.id
  return {
    ok,
    headVersionId: row?.head ?? null,
    fenced: !ok && (await fenceMoved(db, p.fence)),
  }
}
