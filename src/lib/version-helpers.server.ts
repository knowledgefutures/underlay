import { eq } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'

export {
  ajv,
  deriveSemver,
  filterRecordData,
  filterTypeSchema,
  getPrivateFields,
  getPrivateTypes,
  hashRecord,
  hashSchema,
  type SchemaEntry,
} from './core/index.js'

import type { SchemaEntry } from './core/index.js'

/** Load the full schema set for a version (slug → schema body + metadata) */
export async function loadVersionSchemas(versionId: number): Promise<SchemaEntry[]> {
  const rows = await db
    .select({
      slug: schema.versionSchemas.slug,
      schemaId: schema.versionSchemas.schemaId,
      schema: schema.schemas.schema,
      schemaHash: schema.schemas.schemaHash,
    })
    .from(schema.versionSchemas)
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(eq(schema.versionSchemas.versionId, versionId))

  return rows as SchemaEntry[]
}
