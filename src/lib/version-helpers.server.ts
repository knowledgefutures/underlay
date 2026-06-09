import { and, eq } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'

export {
  ajv,
  canonicalize,
  computePublicHash,
  computeVersionHash,
  deriveSemver,
  type ExtraFieldWarning,
  filterRecordData,
  filterSchemasForPublic,
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

import { type SchemaEntry } from './core/index.js'

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

/**
 * Resolve a collection and determine the caller's read access.
 * Returns null when the collection doesn't exist OR is private and the caller
 * isn't an org member — indistinguishable to the caller (404 either way).
 * `ownerAccess` is true when the caller is a member of the owning org.
 */
export async function resolveAccessibleCollection(
  owner: string,
  slug: string,
  userId: string | undefined,
) {
  const [result] = await db
    .select({
      id: schema.collections.id,
      organizationId: schema.collections.organizationId,
      slug: schema.collections.slug,
      public: schema.collections.public,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)
  if (!result) return null
  const ownerAccess = await hasOrgAccess(userId, result.organizationId)
  if (!result.public && !ownerAccess) return null
  return { ...result, ownerAccess }
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

/** Get a user's role in an organization, or null if not a member */
export async function getOrgRole(
  userId: string | undefined,
  orgId: string,
): Promise<string | null> {
  if (!userId) return null
  const [membership] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1)
  return membership?.role ?? null
}
