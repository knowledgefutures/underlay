/**
 * The v3 halves of opening and sizing a push session (api/push.ts): what the head holds,
 * read from the collection's log in the bucket rather than v2's roots.
 */
import { hashSchema, schemaRelaxes } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { loadInputs, type SessionRow } from '../push/session.js'
import { assetsOf, headView, metadataOf, schemasOf } from './catalog.js'

/** The head's schemas and metadata, for a session that keeps them. */
export async function v3BaseInputs(ports: Ports, collectionId: string) {
  const store = ports.stores.v3
  const view = await headView(store, collectionId)
  return { schemas: await schemasOf(store, view), metadata: await metadataOf(store, view) }
}

/**
 * Declared files the caller must still upload: those the head names in no `$asset` row
 * and that were never uploaded for this collection (the test the commit applies).
 */
export async function v3NeededFiles(
  ports: Ports,
  collectionId: string,
  hashes: string[],
): Promise<string[]> {
  if (hashes.length === 0) return []
  const store = ports.stores.v3
  const held = await assetsOf(store, await headView(store, collectionId))
  const rest = hashes.filter((h) => !held.has(h))
  if (rest.length === 0) return []
  const have = new Set<string>()
  for (const part of chunks(rest, JSON_CHUNK)) {
    const rows = await ports.db
      .select({ hash: schema.fileUploads.hash })
      .from(schema.fileUploads)
      .where(
        and(
          eq(schema.fileUploads.collectionId, collectionId),
          eq(schema.fileUploads.status, 'verified'),
          inJson(schema.fileUploads.hash, part),
        ),
      )
    for (const r of rows) have.add(r.hash)
  }
  return rest.filter((h) => !have.has(h))
}

/**
 * Records of the head the commit will check again: those of every type whose schema the
 * session changes in a way that could reject one. Sizes the commit (a large one is a job).
 */
export async function v3Revalidates(ports: Ports, session: SessionRow): Promise<number> {
  if (!session.baseVersionId) return 0
  const [base] = await ports.db
    .select({ typeCounts: schema.versions.typeCounts })
    .from(schema.versions)
    .where(eq(schema.versions.id, session.baseVersionId))
  if (!base) return 0
  const store = ports.stores.v3
  const was = await schemasOf(store, await headView(store, session.collectionId))
  const inputs = await loadInputs(ports, session.id)
  let n = 0
  for (const [type, body] of Object.entries(inputs.schemas)) {
    const before = was[type]
    if (!before || hashSchema(before) === hashSchema(body)) continue
    if (schemaRelaxes(before, body)) continue
    n += base.typeCounts[type] ?? 0
  }
  return n
}
