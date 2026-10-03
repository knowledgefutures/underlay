/**
 * Publish: make a built version visible by moving the collection's head, with
 * compare-and-swap (edge-redesign.md, Commit step 5).
 *
 * D1 has no interactive transactions, so the CAS is one atomic batch whose
 * statements all carry the condition in SQL:
 *   1. insert the version row only if the head is still the base;
 *   2. move the head only if it is still the base and the row from 1 exists;
 *   3. close and open schema_usage rows only if the row from 1 exists.
 * If another commit won, 1 inserts nothing and the rest match nothing; the
 * caller sees that by reading the head back. Everything the version points to is
 * already in the repository, so there is never a half-built version.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'
import type { SetName } from './file-refs.js'

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
  typeCounts: Record<string, number>
  publicTypeCounts: Record<string, number>
  hasPrivate: boolean
  publicRefsRoot: string | null
  privateRefsRoot: string | null
  changes: { added: number; removed: number; updated: number }
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
  baseVersionId: string | null
  collectionUpdate: {
    publicFilesRoot: string | null
    summary: schema.CollectionSummary | null
  }
  schemaHashes: string[]
  usage: SchemaUsageChange[]
}

export async function publishVersion(
  db: Db,
  p: PublishInput,
): Promise<{ ok: boolean; headVersionId: string | null }> {
  const v = p.version
  const now = Date.now()
  const versionExists = sql`EXISTS (SELECT 1 FROM ${schema.versions} WHERE ${schema.versions.id} = ${v.id})`
  const headIsBase = sql`(SELECT ${schema.collections.headVersionId} FROM ${schema.collections} WHERE ${schema.collections.id} = ${v.collectionId}) IS ${p.baseVersionId}`

  const statements = [
    db.run(sql`
      INSERT INTO ${schema.versions} (
        id, collection_id, seq, semver, major, minor, patch, hash, base_semver, message, pushed_by,
        app_id, actor_id, record_count, public_record_count, file_count, total_bytes, type_counts,
        public_type_counts, has_private, public_refs_root, private_refs_root, changes, created_at
      )
      SELECT ${v.id}, ${v.collectionId}, ${v.seq}, ${v.semver}, ${v.major}, ${v.minor}, ${v.patch},
        ${v.hash}, ${v.baseSemver}, ${v.message}, ${v.pushedBy}, ${v.appId}, ${v.actorId},
        ${v.recordCount}, ${v.publicRecordCount}, ${v.fileCount}, ${v.totalBytes},
        ${JSON.stringify(v.typeCounts)}, ${JSON.stringify(v.publicTypeCounts)}, ${v.hasPrivate ? 1 : 0},
        ${v.publicRefsRoot}, ${v.privateRefsRoot}, ${JSON.stringify(v.changes)}, ${now}
      WHERE ${headIsBase}
    `),
    db.run(sql`
      UPDATE ${schema.collections}
      SET head_version_id = ${v.id}, updated_at = ${now},
          public_files_root = ${p.collectionUpdate.publicFilesRoot},
          summary = ${p.collectionUpdate.summary ? JSON.stringify(p.collectionUpdate.summary) : null}
      WHERE id = ${v.collectionId} AND head_version_id IS ${p.baseVersionId} AND ${versionExists}
    `),
    ...p.schemaHashes.map((h) =>
      db.run(sql`INSERT OR IGNORE INTO ${schema.schemas} (hash, created_at) VALUES (${h}, ${now})`),
    ),
    ...p.usage.flatMap((u) => {
      const out = []
      if (u.wasOpen) {
        out.push(
          db.run(sql`
            UPDATE ${schema.schemaUsage} SET to_seq = ${v.seq}
            WHERE collection_id = ${v.collectionId} AND type_slug = ${u.typeSlug} AND "set" = ${u.set}
              AND to_seq IS NULL AND ${versionExists}
          `),
        )
      }
      if (u.schemaHash !== null) {
        out.push(
          db.run(sql`
            INSERT INTO ${schema.schemaUsage} (schema_hash, collection_id, type_slug, "set", from_seq, to_seq)
            SELECT ${u.schemaHash}, ${v.collectionId}, ${u.typeSlug}, ${u.set}, ${v.seq}, NULL
            WHERE ${versionExists}
          `),
        )
      }
      return out
    }),
  ]
  await db.batch(statements as unknown as Parameters<Db['batch']>[0])

  const [row] = await db
    .select({ head: schema.collections.headVersionId })
    .from(schema.collections)
    .where(eq(schema.collections.id, v.collectionId))
    .limit(1)
  return { ok: row?.head === v.id, headVersionId: row?.head ?? null }
}

/** The open schema usage rows of a collection, as `${set}\u0000${slug}` → schema hash. */
export async function openSchemaUsage(db: Db, collectionId: string): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(schema.schemaUsage)
    .where(and(eq(schema.schemaUsage.collectionId, collectionId), isNull(schema.schemaUsage.toSeq)))
  return new Map(rows.map((r) => [`${r.set}\u0000${r.typeSlug}`, r.schemaHash]))
}
