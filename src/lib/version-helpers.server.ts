import { and, eq, sql } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'

export {
  ajv,
  canonicalize,
  checkSchemaBounds,
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
  VersionHashStream,
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
 *
 * When the request authenticated with a collection-scoped API key (share/agent
 * links), pass `apiKeyCollectionIds` — the key's identity only counts for the
 * collections it is scoped to; anything else is treated as anonymous.
 */
export async function resolveAccessibleCollection(
  owner: string,
  slug: string,
  userId: string | undefined,
  apiKeyCollectionIds?: string[],
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
  const keyScopeOk = !apiKeyCollectionIds || apiKeyCollectionIds.includes(result.id)
  const ownerAccess = keyScopeOk && (await hasOrgAccess(userId, result.organizationId))
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

/** Get the latest ready version of a collection (highest semver), or null */
export async function getLatestReadyVersion(collectionId: string) {
  const [version] = await db
    .select()
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.status, 'ready')))
    .orderBy(
      sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
    )
    .limit(1)
  return version ?? null
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
