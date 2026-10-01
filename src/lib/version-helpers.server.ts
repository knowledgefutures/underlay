import { and, eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'

import type { AuthEnv } from '../api/auth.server.js'
import { db, schema } from '../db/client.server.js'
import {
  type CollectionWriteOptions,
  decideCollectionWrite,
  keyScopeAllows,
} from './collection-access.js'

export {
  ajv,
  canonicalize,
  checkSchemaBounds,
  compileSchema,
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
      public: schema.collections.public,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)
  return result ?? null
}

type ResolvedCollection = NonNullable<Awaited<ReturnType<typeof resolveCollection>>>

/**
 * Read access to an already-resolved collection, for routes that select more
 * columns than `resolveAccessibleCollection` does. `visible` is false for a
 * private collection the caller isn't a member of, which callers report as 404.
 * A collection-scoped API key only counts for the collections it is scoped to.
 */
export async function collectionReadAccess(
  collection: { id: string; organizationId: string; public: boolean },
  userId: string | undefined,
  apiKeyCollectionIds?: string[],
): Promise<{ visible: boolean; ownerAccess: boolean }> {
  const ownerAccess =
    keyScopeAllows(apiKeyCollectionIds, collection.id) &&
    (await hasOrgAccess(userId, collection.organizationId))
  return { visible: collection.public || ownerAccess, ownerAccess }
}

/**
 * Resolve owner/slug and check the caller may write to it: a member of the
 * owning org (owner or admin with `minRole: 'admin'`), and, if the API key is
 * collection-scoped, scoped to this collection. `role` is the caller's role in
 * the owning org.
 *
 * The options keep each route's existing status codes, messages and check order
 * (see `CollectionWriteOptions`).
 */
export async function authorizeCollectionWrite<E extends AuthEnv>(
  c: Context<E>,
  owner: string,
  slug: string,
  options: CollectionWriteOptions = {},
): Promise<{ collection: ResolvedCollection; role: string } | { error: Response }> {
  const collection = await resolveCollection(owner, slug)
  const decision = await decideCollectionWrite(
    collection,
    {
      scopedCollectionIds: c.get('apiKeyCollectionIds'),
      getRole: () => getOrgRole(c.get('userId'), collection!.organizationId),
    },
    options,
  )
  if ('denial' in decision) {
    const { status, error } = decision.denial
    return { error: c.json({ error, statusCode: status }, status) }
  }
  return { collection: collection!, role: decision.role }
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
  const result = await resolveCollection(owner, slug)
  if (!result) return null
  const { visible, ownerAccess } = await collectionReadAccess(result, userId, apiKeyCollectionIds)
  if (!visible) return null
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

/**
 * Strip owner-only data from a version row before returning it to a non-owner:
 * private-type entries in `typeCounts` (which would disclose the existence and
 * exact size of private types) and the internal provenance fields.
 */
export function sanitizeVersionForPublic(
  version: Record<string, any>,
  privateTypes: Set<string>,
): Record<string, any> {
  const out: Record<string, any> = { ...version }
  const tc = version.typeCounts as Record<string, number> | null | undefined
  if (tc) {
    out.typeCounts = Object.fromEntries(
      Object.entries(tc).filter(([type]) => !privateTypes.has(type)),
    )
  }
  delete out.pushedBy
  delete out.actorId
  delete out.signature
  return out
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

/**
 * Flatten an error and its `cause` chain into one string.
 *
 * Drizzle puts the SQL in `message` and the underlying Postgres error — the part
 * that says *why* — in `cause`. Recording only `message` yields "Failed query:
 * SELECT …" with no reason, which is unactionable for whoever is reading a
 * failed session or job hours later.
 */
export function describeError(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      parts.push(current.message)
      // Postgres errors carry the useful specifics outside `message`.
      const pg = current as { code?: string; detail?: string; hint?: string }
      const extra = [
        pg.code && `code ${pg.code}`,
        pg.detail && `detail: ${pg.detail}`,
        pg.hint && `hint: ${pg.hint}`,
      ].filter(Boolean)
      if (extra.length > 0) parts.push(extra.join(', '))
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.join(' | ')
}

/**
 * The version whose `version_records` rows hold this version's record set.
 *
 * A metadata-only patch version shares its base's rows rather than copying them,
 * so its own id matches nothing in `version_records`. Every query that filters or
 * joins that table on `version_id` must go through here. Passing a raw
 * `version.id` instead returns an empty record set — no error, just nothing.
 *
 * The pointer is always one hop by construction (see `versions.records_from_version_id`),
 * so this needs no recursion.
 *
 * `recordsFromVersionId` is deliberately required rather than optional: a version
 * fetched with a narrow projection that omitted the column would otherwise
 * resolve to its own id and silently read an empty record set. Making it required
 * turns that into a compile error at every call site.
 */
export function recordsVersionId(v: { id: number; recordsFromVersionId: number | null }): number {
  return v.recordsFromVersionId ?? v.id
}
