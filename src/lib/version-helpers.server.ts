import { createHash } from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'

export {
  ajv,
  canonicalize,
  deriveSemver,
  type ExtraFieldWarning,
  filterRecordData,
  filterTypeSchema,
  findExtraFields,
  getPrivateFields,
  getPrivateTypes,
  hashRecord,
  hashSchema,
  parseSemver,
  type SchemaEntry,
  type SemverComponents,
  stripToSchema,
} from './core/index.js'

import {
  canonicalize,
  filterRecordData,
  filterTypeSchema,
  getPrivateFields,
  getPrivateTypes,
  hashRecord,
  hashSchema,
  type SchemaEntry,
} from './core/index.js'

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

/** Resolve a collection by owner slug + collection slug */
export async function resolveCollection(owner: string, slug: string) {
  const [result] = await db
    .select({
      id: schema.collections.id,
      organizationId: schema.collections.organizationId,
      slug: schema.collections.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)
  return result ?? null
}

/** Check if a user is a member of an organization */
export async function hasOrgAccess(userId: string | undefined, orgId: string): Promise<boolean> {
  if (!userId) return false
  const [membership] = await db
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1)
  return !!membership
}

/** Compute the private (all-content) version hash */
export function computeVersionHash(
  schemaSet: { slug: string; schemaHash: string }[],
  recordHashes: string[],
  fileHashes: string[],
  metadata: Record<string, unknown> | null,
): string {
  const canonical = JSON.stringify({
    schemas: Object.fromEntries(
      [...schemaSet]
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((s) => [s.slug, s.schemaHash]),
    ),
    records: [...recordHashes].sort(),
    files: [...fileHashes].sort(),
    metadata: metadata ? canonicalize(metadata) : null,
  })
  return 'private:' + createHash('sha256').update(canonical).digest('hex')
}

/** Build a public-facing schemas map (excluding private types, stripping private fields) */
export function filterSchemasForPublic(schemaEntries: SchemaEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const entry of schemaEntries) {
    if ((entry.schema as any)?.private === true) continue
    result[entry.slug] = filterTypeSchema(entry.schema)
  }
  return result
}

/** Compute the public (privacy-filtered) version hash */
export function computePublicHash(
  schemaEntries: SchemaEntry[],
  recordRows: { recordId: string; type: string; data: unknown; private: boolean }[],
  fileHashes: string[],
  metadata: Record<string, unknown> | null,
): string {
  const privateTypes = getPrivateTypes(schemaEntries)

  const publicSchemaSet: { slug: string; schemaHash: string }[] = []
  for (const entry of schemaEntries) {
    if (privateTypes.has(entry.slug)) continue
    const filtered = filterTypeSchema(entry.schema)
    publicSchemaSet.push({ slug: entry.slug, schemaHash: hashSchema(filtered) })
  }

  const publicRecordHashes = recordRows
    .filter((r) => !r.private && !privateTypes.has(r.type))
    .map((r) => {
      const entry = schemaEntries.find((e) => e.slug === r.type)
      const privateFields = entry ? getPrivateFields(entry.schema) : new Set<string>()
      const data = privateFields.size > 0 ? filterRecordData(r.data, privateFields) : r.data
      return hashRecord({ id: r.recordId, type: r.type, data }).hash
    })

  return computeVersionHash(publicSchemaSet, publicRecordHashes, fileHashes, metadata).replace(
    'private:',
    'public:',
  )
}
