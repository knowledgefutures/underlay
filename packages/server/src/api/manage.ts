/**
 * Creating and changing collections (v1 shapes).
 *
 *   POST   /api/accounts/:owner/collections            {slug, name?, public?}
 *   PATCH  /api/collections/:owner/:slug               {name?, slug?, public?}
 *   DELETE /api/collections/:owner/:slug
 *   POST   /api/collections/:owner/:slug/transfer      {targetOrgSlug}
 *   POST   /api/collections/:owner/:slug/fork          {targetOrg, slug?}
 *   POST   /api/collections/:owner/:slug/metadata      {...metadata patch}
 *
 * Collection settings are mutable rows; nothing here rewrites version data.
 * A metadata edit is a new version that reuses every set: one root object.
 */
import { and, count, eq, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { validateSlug } from '../lib/slug.js'
import { headBase } from '../push/delta.js'
import { commitVersion } from '../versions/commit.js'
import { createCollectionRows, forkCollection } from '../versions/fork.js'
import { jsonError, requireCollection } from './access.js'
import { ensureCollectionArk } from './ark.js'
import { readJson } from './body.js'

/** A metadata patch, like a push's opening body, is at most 8 MB. */
const MAX_METADATA_BODY = 8 * 1024 * 1024

/** The org named `orgSlug` and the caller's role in it (null when not a member). */
export async function membership(c: Context<AppEnv>, orgSlug: string) {
  const p = c.var.principal
  const [org] = await c.var.ports.db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.slug, orgSlug))
    .limit(1)
  if (!org) return { org: null, role: null }
  if (!p || p.collectionIds || p.scope === 'read') return { org, role: null }
  if (p.orgId) return { org, role: p.orgId === org.id ? 'owner' : null }
  const [m] = await c.var.ports.db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, p.userId)))
    .limit(1)
  return { org, role: m?.role ?? null }
}

export const isAdmin = (role: string | null) => role === 'owner' || role === 'admin'

export function manageRoutes() {
  const app = new Hono<AppEnv>()

  app.post('/api/accounts/:owner/collections', async (c) => {
    if (!c.var.principal) return jsonError(c, 401, 'Authentication required')
    const { org, role } = await membership(c, c.req.param('owner'))
    if (!org) return jsonError(c, 404, 'Org not found')
    if (!role) return jsonError(c, 403, 'Forbidden')
    const body = (await c.req.json().catch(() => null)) as {
      slug?: unknown
      name?: unknown
      public?: unknown
    } | null
    const slugError = validateSlug(body?.slug)
    if (slugError) return jsonError(c, 422, slugError)
    const slug = body!.slug as string
    const [taken] = await c.var.ports.db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(and(eq(schema.collections.organizationId, org.id), eq(schema.collections.slug, slug)))
      .limit(1)
    if (taken) return jsonError(c, 409, 'Collection already exists')
    const name =
      typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : slug
    const col = await createCollectionRows(c.var.ports, {
      organizationId: org.id,
      slug,
      name,
      public: body?.public === true,
    })
    // Every new collection gets an ARK, as in v1.
    await ensureCollectionArk(c.var.ports.db, { id: col.id, organizationId: org.id })
    return c.json({ id: col.id, owner: org.slug, slug, name }, 201)
  })

  app.patch('/api/collections/:owner/:slug', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown
      slug?: unknown
      public?: unknown
    }
    const set: Partial<typeof schema.collections.$inferInsert> = {}
    if (typeof body.name === 'string' && body.name.trim()) set.name = body.name.trim().slice(0, 200)
    if (body.public !== undefined) {
      // Visibility is an admin decision (v1 rule): it changes who can read every version.
      if (!isAdmin(access.role))
        return jsonError(c, 403, 'Only org owners and admins can change visibility')
      set.public = body.public === true
    }
    if (body.slug !== undefined && body.slug !== access.collection.slug) {
      const err = validateSlug(body.slug)
      if (err) return jsonError(c, 422, err)
      const [taken] = await c.var.ports.db
        .select({ id: schema.collections.id })
        .from(schema.collections)
        .where(
          and(
            eq(schema.collections.organizationId, access.owner.id),
            eq(schema.collections.slug, body.slug as string),
          ),
        )
        .limit(1)
      if (taken) return jsonError(c, 409, 'Collection already exists')
      set.slug = body.slug as string
    }
    if (Object.keys(set).length > 0) {
      await c.var.ports.db
        .update(schema.collections)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(schema.collections.id, access.collection.id))
    }
    return c.json({ ok: true, slug: set.slug ?? access.collection.slug })
  })

  app.delete('/api/collections/:owner/:slug', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    if (!isAdmin(access.role)) return jsonError(c, 403, 'Forbidden')
    // Rows go (cascading to versions, sessions, placements, webhooks). Repository
    // objects stay until garbage collection exists (edge-redesign.md, Storage layout).
    // The tombstone keeps the counters the deletion zeroes, and tells reference-log
    // compaction to drop the collection's events.
    const { db } = c.var.ports
    const col = access.collection
    const [totals] = await db
      .select({ n: count(), bytes: sql<number>`coalesce(sum(${schema.versions.totalBytes}), 0)` })
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, col.id))
    await db.batch([
      db
        .insert(schema.collectionTombstones)
        .values({
          collectionId: col.id,
          organizationId: col.organizationId,
          slug: col.slug,
          refEvents: col.refEvents,
          refBytes: col.refBytes,
          versions: totals?.n ?? 0,
          totalBytes: Number(totals?.bytes ?? 0),
          deletedBy: c.var.principal?.userId ?? null,
        })
        .onConflictDoUpdate({
          target: schema.collectionTombstones.collectionId,
          set: {
            slug: col.slug,
            refEvents: col.refEvents,
            refBytes: col.refBytes,
            deletedAt: new Date(),
          },
        }),
      db.delete(schema.collections).where(eq(schema.collections.id, col.id)),
    ])
    return c.json({ ok: true })
  })

  app.post('/api/collections/:owner/:slug/transfer', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    if (!isAdmin(access.role)) return jsonError(c, 403, 'Forbidden')
    const body = (await c.req.json().catch(() => ({}))) as { targetOrgSlug?: unknown }
    if (typeof body.targetOrgSlug !== 'string')
      return jsonError(c, 400, '"targetOrgSlug" is required')
    const target = await membership(c, body.targetOrgSlug)
    if (!target.org) return jsonError(c, 404, 'Target org not found')
    if (!isAdmin(target.role))
      return jsonError(c, 403, 'You must be an owner or admin of the target org')
    const [taken] = await c.var.ports.db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(
        and(
          eq(schema.collections.organizationId, target.org.id),
          eq(schema.collections.slug, access.collection.slug),
        ),
      )
      .limit(1)
    if (taken) return jsonError(c, 409, 'The target org already has a collection with this slug')
    await c.var.ports.db
      .update(schema.collections)
      .set({ organizationId: target.org.id, updatedAt: new Date() })
      .where(eq(schema.collections.id, access.collection.id))
    return c.json({ ok: true, newOwner: target.org.slug })
  })

  app.post('/api/collections/:owner/:slug/fork', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    if (!c.var.principal) return jsonError(c, 401, 'Authentication required')
    const body = await readJson(c, 64 * 1024)
    if (body instanceof Response) return body
    if (typeof body.targetOrg !== 'string') return jsonError(c, 400, '"targetOrg" is required')
    const target = await membership(c, body.targetOrg)
    if (!target.org) return jsonError(c, 404, 'Target org not found')
    if (!target.role) return jsonError(c, 403, 'Forbidden')
    const slug = typeof body.slug === 'string' ? body.slug : access.collection.slug
    const err = validateSlug(slug)
    if (err) return jsonError(c, 422, err)
    const head = access.collection.headVersionId
    if (!head) return jsonError(c, 422, 'Nothing to fork: the collection has no versions')
    const [version] = await c.var.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, head))
    const [taken] = await c.var.ports.db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(
        and(
          eq(schema.collections.organizationId, target.org.id),
          eq(schema.collections.slug, slug),
        ),
      )
      .limit(1)
    if (taken) return jsonError(c, 409, 'Collection already exists')
    const forked = await forkCollection(
      c.var.ports,
      { collection: access.collection, version: version! },
      { organizationId: target.org.id, slug, name: access.collection.name, public: false },
      access.isMember,
    )
    return c.json(
      {
        id: forked.collection.id,
        owner: target.org.slug,
        slug,
        name: forked.collection.name,
        forkedFrom: {
          owner: access.owner.slug,
          slug: access.collection.slug,
          version: version!.semver,
        },
        version: { semver: forked.version.semver, recordCount: forked.version.recordCount },
      },
      201,
    )
  })

  app.post('/api/collections/:owner/:slug/metadata', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    // Metadata goes into the version root, so it follows the input rules.
    const patch = await readJson(c, MAX_METADATA_BODY)
    if (patch instanceof Response) return patch
    const ports = c.var.ports
    const base = await headBase(ports, access.collection.id)
    if (!base) return jsonError(c, 422, 'No versions exist yet')
    const repo = await ports.stores.forCollection(access.collection.id)
    const root = await repo.root(base.hash)
    const priv = root.private ? await repo.privateSet(root.private) : null
    const metadata = { ...(root.metadata ?? {}), ...patch }
    if (JSON.stringify(metadata) === JSON.stringify(root.metadata))
      return c.json({ semver: base.semver, unchanged: true })
    const hashes = new Map<string, string>()
    for (const [slug, t] of Object.entries(priv?.types ?? {})) hashes.set(slug, t.schema)
    for (const [slug, t] of Object.entries(root.public.types)) hashes.set(slug, t.schema)
    const types = await Promise.all(
      [...hashes].map(async ([slug, h]) => ({
        slug,
        schema: await repo.schema(h),
        schemaHash: h,
        public: null,
        private: null,
      })),
    )
    const r = await commitVersion(ports, {
      collectionId: access.collection.id,
      base,
      types,
      metadata,
      message: 'Metadata update',
      pushedBy: c.var.principal?.userId ?? null,
    })
    if (r.status === 'conflict') return jsonError(c, 409, 'Version conflict')
    if (r.status !== 'committed') return c.json({ semver: base.semver, unchanged: true })
    return c.json({ semver: r.version.semver, hash: r.version.hash, status: 'completed' }, 201)
  })

  return app
}
