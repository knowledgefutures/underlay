/**
 * `version_file_refs`: the `$file` references in a version's record set, derived
 * once at commit so file access checks and the file listing read an index
 * instead of scanning record bodies.
 *
 * A reference is found by walking each top-level field of a record's data:
 *
 * - an object whose `$file` is a string is a reference, and the walk stops there;
 * - any other object or array is descended into (an object with a non-string
 *   `$file` included).
 *
 * The hash is the string with its first `sha256:` removed, as the file listing
 * and the export always computed it. The two readers used to disagree on which
 * references count, and each reads its own subset so that neither answer
 * changes:
 *
 * - access checks: any depth, but only strings that start with `sha256:`
 *   (`prefixed`), which is what they matched against;
 * - the file listing: only the field's value itself (`nested = false`), with or
 *   without the prefix.
 *
 * `private` folds together the three ways a reference is hidden from non-owners:
 * the record is private in the version, its type is private, or the top-level
 * field is private in that type's schema. Both readers apply exactly that
 * filter, and a version's schemas never change after commit.
 *
 * The same SQL backfills existing versions in migration 0017_version_file_refs;
 * keep the two in step.
 */
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'

type Executor = Pick<typeof db, 'execute'>

/** Exported for the test that keeps the migration's backfill in step with it. */
export function insertFileRefs(versionFilter: SQL): SQL {
  return sql`
    INSERT INTO version_file_refs
      (version_id, file_hash, prefixed, record_id, type, field, nested, private)
    WITH RECURSIVE walk (version_id, record_id, type, record_private, field, node, nested) AS (
      SELECT vr.version_id, vr.record_id, vr.type, vr.private, top.key, top.value, false
      FROM version_records vr
      INNER JOIN record_objects ro ON ro.hash = vr.record_hash
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(ro.data) = 'object' THEN ro.data ELSE '{}'::jsonb END
      ) top
      WHERE ${versionFilter}
        -- Cheap prefilter: most records hold no references at all.
        AND ro.data::text LIKE '%"$file"%'
      UNION ALL
      SELECT w.version_id, w.record_id, w.type, w.record_private, w.field, child.value, true
      FROM walk w
      CROSS JOIN LATERAL (
        SELECT value FROM jsonb_each(
          CASE WHEN jsonb_typeof(w.node) = 'object' THEN w.node ELSE '{}'::jsonb END
        )
        UNION ALL
        SELECT value FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(w.node) = 'array' THEN w.node ELSE '[]'::jsonb END
        )
      ) child
      WHERE jsonb_typeof(w.node) IN ('object', 'array')
        AND jsonb_typeof(w.node -> '$file') IS DISTINCT FROM 'string'
    )
    SELECT DISTINCT
      w.version_id,
      -- No 'g' flag: only the first occurrence, like String.prototype.replace.
      regexp_replace(w.node ->> '$file', 'sha256:', ''),
      left(w.node ->> '$file', 7) = 'sha256:',
      w.record_id,
      w.type,
      w.field,
      w.nested,
      w.record_private
        OR coalesce(s.schema -> 'private' = 'true'::jsonb, false)
        OR coalesce(s.schema -> 'properties' -> w.field -> 'private' = 'true'::jsonb, false)
    FROM walk w
    LEFT JOIN version_schemas vs ON vs.version_id = w.version_id AND vs.slug = w.type
    LEFT JOIN schemas s ON s.id = vs.schema_id
    WHERE jsonb_typeof(w.node -> '$file') = 'string'
  `
}

/**
 * Derive a version's file refs from its `version_records` and `version_schemas`.
 * Call once both are fully written and before the version is marked ready, and
 * only for a version that owns its rows (not a metadata patch).
 */
export async function indexVersionFileRefs(
  versionId: number,
  executor: Executor = db,
): Promise<void> {
  await executor.execute(insertFileRefs(sql`vr.version_id = ${versionId}`))
}

/**
 * Copy one version's refs to another with an identical record set and schemas
 * (a fork). Cheaper than re-deriving, and identical by construction.
 */
export async function copyVersionFileRefs(
  fromVersionId: number,
  toVersionId: number,
  executor: Executor = db,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO version_file_refs
      (version_id, file_hash, prefixed, record_id, type, field, nested, private)
    SELECT ${toVersionId}, file_hash, prefixed, record_id, type, field, nested, private
    FROM version_file_refs
    WHERE version_id = ${fromVersionId}
  `)
}

// --- Readers ---

/** The references `/versions/:n/files` lists, keyed by bare file hash. */
export async function listedFileRefs(
  recordsVersionId: number,
  ownerAccess: boolean,
): Promise<Map<string, { recordId: string; type: string; field: string }[]>> {
  // Only a field value that is itself `{"$file": …}` (`nested = false`) is
  // listed. Non-owners never see one that sits in a private record, type or
  // field, and so never see a file reachable only that way.
  const conditions = [
    eq(schema.versionFileRefs.versionId, recordsVersionId),
    eq(schema.versionFileRefs.nested, false),
  ]
  if (!ownerAccess) conditions.push(eq(schema.versionFileRefs.private, false))
  const rows = await db
    .select({
      hash: schema.versionFileRefs.fileHash,
      recordId: schema.versionFileRefs.recordId,
      type: schema.versionFileRefs.type,
      field: schema.versionFileRefs.field,
    })
    .from(schema.versionFileRefs)
    .where(and(...conditions))

  const refs = new Map<string, { recordId: string; type: string; field: string }[]>()
  for (const { hash, ...ref } of rows) {
    if (!refs.has(hash)) refs.set(hash, [])
    refs.get(hash)!.push(ref)
  }
  return refs
}

/**
 * The subset of `fileHashes` (bare, no `sha256:`) the caller may download from
 * `collection`, as returned by `resolveAccessibleCollection` (null when the
 * collection doesn't exist or is private to the caller, so a non-owner only gets
 * here for a public collection). Two indexed lookups however many hashes are
 * asked about.
 */
export async function accessibleFileHashes(
  collection: { id: string; ownerAccess: boolean } | null,
  fileHashes: string[],
): Promise<Set<string>> {
  if (!collection || fileHashes.length === 0) return new Set()

  // The file must actually belong to THIS collection (in any of its versions).
  // Without this, the owner/slug in the path is decorative: a member could fetch
  // any file in the system by requesting it under a collection they belong to.
  const belonging = await db
    .selectDistinct({ fileHash: schema.versionFiles.fileHash })
    .from(schema.versionFiles)
    .innerJoin(schema.versions, eq(schema.versionFiles.versionId, schema.versions.id))
    .where(
      and(
        eq(schema.versions.collectionId, collection.id),
        inArray(schema.versionFiles.fileHash, fileHashes),
      ),
    )
  const belongs = belonging.map((r) => r.fileHash)
  if (collection.ownerAccess || belongs.length === 0) return new Set(belongs)

  // OR across every ready version: a file is accessible if it is referenced via
  // a non-private field of a non-private record of a non-private type in ANY
  // ready version of this (public) collection. Files are content-addressed and
  // immutable, and the URL carries no version, so "published publicly in any
  // accessible version ⇒ public" is the correct resolution.
  //
  // Refs are keyed by the version that owns the record rows. A metadata patch
  // shares its base's rows and schemas, and both are in this collection, so
  // asking of the owner alone gives the same answer.
  const referenced = await db
    .selectDistinct({ fileHash: schema.versionFileRefs.fileHash })
    .from(schema.versionFileRefs)
    .innerJoin(schema.versions, eq(schema.versionFileRefs.versionId, schema.versions.id))
    .where(
      and(
        inArray(schema.versionFileRefs.fileHash, belongs),
        eq(schema.versionFileRefs.prefixed, true),
        eq(schema.versionFileRefs.private, false),
        eq(schema.versions.collectionId, collection.id),
        eq(schema.versions.status, 'ready'),
      ),
    )
  return new Set(referenced.map((r) => r.fileHash))
}
