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
  /** The signed-in session's id (scope 'session' only). */
  sessionId?: string
}

/**
 * The role a caller acts with: a key's scope caps its holder's role. Sessions
 * and admin keys keep the full role; read and write keys act as members, so
 * they can't change visibility, delete, or manage mirrors, webhooks or the org.
 * A key confined to some collections acts as a member too, whatever its scope:
 * it may write to them, never manage them (see keyCannotManage).
 */
export function capRole(p: Principal, role: string | null): string | null {
  if (!role) return null
  if (p.collectionIds) return 'member'
  return p.scope === 'session' || p.scope === 'admin' ? role : 'member'
}

/**
 * 403 for a key confined to some collections, on a route that manages a
 * collection (visibility, deletion, transfer, webhooks, placements); null for
 * anyone else. capRole already keeps such a key from an admin's role; this
 * says why.
 */
export function keyCannotManage(c: Context<AppEnv>): Response | null {
  return c.var.principal?.collectionIds
    ? jsonError(c, 403, 'This key cannot manage collections')
    : null
}

export interface CollectionAccess {
  collection: typeof schema.collections.$inferSelect
  owner: typeof schema.organization.$inferSelect
  /** Members of the owning org read both sets. */
  isMember: boolean
  /**
   * The member's role in the owning org ('owner' | 'admin' | 'member'), when a
   * member, capped by the key's scope (capRole).
   */
  role: string | null
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
  let role: string | null = null
  if (principal) {
    const keyCovers =
      principal.collectionIds === null || principal.collectionIds.includes(row.collection.id)
    if (keyCovers && principal.orgId) {
      isMember = principal.orgId === row.owner.id
      // An org-owned key acts with the org's authority, as far as its scope goes.
      if (isMember) role = capRole(principal, 'owner')
    } else if (keyCovers) {
      const [m] = await db
        .select({ id: schema.member.id, role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, row.owner.id),
            eq(schema.member.userId, principal.userId),
          ),
        )
        .limit(1)
      isMember = !!m
      role = capRole(principal, m?.role ?? null)
    }
  }
  const canRead = row.collection.public || isMember
  const canWrite = isMember && principal !== null && principal.scope !== 'read'
  return {
    ...row,
    isMember,
    role,
    canRead,
    canWrite,
    sets: isMember ? ['public', 'private'] : ['public'],
  }
}

export const jsonError = (
  c: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 451 | 500 | 503,
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
  const owner = c.req.param('owner') ?? ''
  const slug = c.req.param('slug') ?? ''
  const resolve = () => collectionAccess(c.var.ports.db, c.var.principal, owner, slug)
  // A page's in-process calls resolve each collection once (app.ts PageContext).
  const memo = c.var.page?.access
  const key = `${owner}/${slug}`
  if (memo && !memo.has(key)) memo.set(key, resolve())
  const access = (await (memo?.get(key) ?? resolve())) as CollectionAccess | null
  if (!access || !access.canRead) return jsonError(c, 404, 'Collection not found')
  if (need === 'write' && !access.canWrite) {
    return c.var.principal
      ? jsonError(c, 403, 'Not authorized')
      : jsonError(c, 401, 'Authentication required')
  }
  // Usage on this request is billed to the collection's owner (billing/usage.ts).
  c.var.meter.collection = { id: access.collection.id, accountId: access.owner.id }
  return access
}
