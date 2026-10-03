/**
 * Who is calling, and what they may do with a collection.
 *
 * Authorization happens once per request: the collection's visibility and the
 * caller's membership pick which sets the caller may read (edge-redesign.md,
 * Read path). Nothing below filters individual records.
 */
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export interface Principal {
  userId: string
  /** 'session' for a signed-in browser; otherwise the API key's scope. */
  scope: 'session' | 'read' | 'write' | 'admin'
  /** Collections an API key is limited to; null when unscoped. */
  collectionIds: string[] | null
  /** Set for an API key owned by an organization: it acts as a member of that org only. */
  orgId?: string
}

export interface CollectionAccess {
  collection: typeof schema.collections.$inferSelect
  owner: typeof schema.organization.$inferSelect
  /** Members of the owning org read both sets. */
  isMember: boolean
  canRead: boolean
  canWrite: boolean
  /** Which sets this caller may read. */
  sets: ('public' | 'private')[]
}

export async function collectionAccess(
  db: Db,
  principal: Principal | null,
  ownerSlug: string,
  slug: string,
): Promise<CollectionAccess | null> {
  const [row] = await db
    .select({ collection: schema.collections, owner: schema.organization })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
    .where(and(eq(schema.organization.slug, ownerSlug), eq(schema.collections.slug, slug)))
    .limit(1)
  if (!row || row.collection.deletedAt) return null

  let isMember = false
  if (principal) {
    const keyCovers =
      principal.collectionIds === null || principal.collectionIds.includes(row.collection.id)
    if (keyCovers && principal.orgId) {
      isMember = principal.orgId === row.owner.id
    } else if (keyCovers) {
      const [m] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, row.owner.id),
            eq(schema.member.userId, principal.userId),
          ),
        )
        .limit(1)
      isMember = !!m
    }
  }
  const canRead = row.collection.public || isMember
  const canWrite = isMember && principal !== null && principal.scope !== 'read'
  return {
    ...row,
    isMember,
    canRead,
    canWrite,
    sets: isMember ? ['public', 'private'] : ['public'],
  }
}

export const jsonError = (
  c: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500,
  error: string,
  extra: Record<string, unknown> = {},
) => c.json({ error, statusCode: status, ...extra }, status)

/**
 * Resolve `:owner/:slug` for a request. A collection the caller can't read is a
 * 404, so private collections don't leak their existence.
 */
export async function requireCollection(
  c: Context<AppEnv>,
  need: 'read' | 'write',
): Promise<CollectionAccess | Response> {
  const access = await collectionAccess(
    c.var.ports.db,
    c.var.principal,
    c.req.param('owner') ?? '',
    c.req.param('slug') ?? '',
  )
  if (!access || !access.canRead) return jsonError(c, 404, 'Collection not found')
  if (need === 'write' && !access.canWrite) {
    return c.var.principal
      ? jsonError(c, 403, 'Not authorized')
      : jsonError(c, 401, 'Authentication required')
  }
  return access
}
