/**
 * Shared by seed.ts and seedKfCollections.ts. Hashing goes through lib/core so
 * seeded records, schemas and versions hash exactly as a push would.
 */
import { eq } from 'drizzle-orm'

import { computeVersionHash, hashRecord, hashSchema } from '../lib/core/index.js'
import { db, schema } from './client.server.js'

export interface SeedRecord {
  recordId: string
  type: string
  data: unknown
}

function hashSeedRecord(r: SeedRecord) {
  return hashRecord({ id: r.recordId, type: r.type, data: r.data })
}

/** Version content hash for a seeded record set. */
export function seedVersionHash(
  schemaSet: { slug: string; schemaHash: string }[],
  records: SeedRecord[],
  fileHashes: string[],
  metadata: Record<string, unknown> | null,
): string {
  return computeVersionHash(
    schemaSet,
    records.map((r) => hashSeedRecord(r).hash),
    fileHashes,
    metadata,
  )
}

/** Insert records as content-addressed objects and link them to a version. */
export async function insertRecords(versionId: number, records: SeedRecord[]): Promise<void> {
  const objectRows = records.map((r) => {
    const { hash, canonical } = hashSeedRecord(r)
    return {
      hash,
      recordId: r.recordId,
      type: r.type,
      data: r.data as any,
      size: Buffer.byteLength(canonical, 'utf8'),
    }
  })
  await db.insert(schema.recordObjects).values(objectRows).onConflictDoNothing()
  await db
    .insert(schema.versionRecords)
    .values(
      objectRows.map((r) => ({
        versionId,
        recordHash: r.hash,
        recordId: r.recordId,
        type: r.type,
      })),
    )
    .onConflictDoNothing()
}

/** Insert schemas into the global table, returning schema IDs. Deduplicates by hash. */
export async function upsertSchemas(
  schemasMap: Record<string, object>,
): Promise<{ slug: string; schemaId: string; schemaHash: string }[]> {
  const results: { slug: string; schemaId: string; schemaHash: string }[] = []
  for (const [slug, body] of Object.entries(schemasMap)) {
    const hash = hashSchema(body)
    const existing = await db
      .select({ id: schema.schemas.id })
      .from(schema.schemas)
      .where(eq(schema.schemas.schemaHash, hash))
      .limit(1)

    let schemaId: string
    if (existing.length > 0) {
      schemaId = existing[0]!.id
    } else {
      const [inserted] = await db
        .insert(schema.schemas)
        .values({ schema: body as any, schemaHash: hash })
        .returning({ id: schema.schemas.id })
      schemaId = inserted!.id
    }
    results.push({ slug, schemaId, schemaHash: hash })
  }
  return results
}
