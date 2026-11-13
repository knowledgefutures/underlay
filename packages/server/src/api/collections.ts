/**
 * Collection, account and app-context reads (v1 shapes: docs/v1-read-api.md).
 *
 *   GET /api/context
 *   GET /api/collections                       list and explore
 *   GET /api/collections/:owner/:slug          detail (spec 11.3.3, plus v1's members)
 *   GET /api/accounts/:owner/collections
 *   GET /api/accounts/:slug, /api/accounts/:slug/members
 *   PUT /api/accounts/:slug/members/me      show or hide one's own membership
 *
 * Everything here is SQLite rows: no repository reads. Lists show what a
 * caller may see: public counts to non-members, full counts to members.
 */
import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'
import { metadataOf } from '../v3/catalog.js'
import { readStore, readView } from '../v3/read-cache.js'
import { jsonError, type Principal, reachesOrg, requireCollection } from './access.js'
import { collectionArk } from './ark.js'
import { membership } from './manage.js'

type VersionRow = typeof schema.versions.$inferSelect

/**
 * Org ids the principal acts as a member of: empty for anonymous or collection-scoped
 * keys, and only its organization for a key made for one.
 */
async function memberOrgIds(db: Db, p: Principal | null): Promise<string[]> {
  if (!p || p.collectionIds) return []
  const rows = await db
    .select({ id: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, p.userId))
  return rows.map((r) => r.id).filter((id) => reachesOrg(p, id))
}

/** A version as a caller sees it in lists and the collection detail. */
export function versionSummary(
  v: VersionRow,
  owner: boolean,
  ark: ((semver: string) => string) | null = null,
) {
  return {
    semver: v.semver,
    major: v.major,
    minor: v.minor,
    patch: v.patch,
    hash: v.hash,
    baseSemver: v.baseSemver,
    message: v.message,
    appId: v.appId,
    ...(owner ? { pushedBy: v.pushedBy, actorId: v.actorId } : {}),
    recordCount: owner ? v.recordCount : v.publicRecordCount,
    fileCount: owner ? v.fileCount : v.publicFileCount,
    totalBytes: owner ? v.totalBytes : v.publicTotalBytes,
    typeCounts: owner ? v.typeCounts : v.publicTypeCounts,
    createdAt: v.createdAt,
    ark: ark ? ark(v.semver) : null,
  }
}

/** Versions with their pusher's name added, where the caller sees `pushedBy`. */
export async function withPusherNames<T extends { pushedBy?: string | null }>(
  db: Db,
  versions: T[],
): Promise<(T & { pushedByName?: string | null })[]> {
  const ids = [...new Set(versions.map((v) => v.pushedBy).filter((id): id is string => !!id))]
  if (ids.length === 0) return versions
  const names = new Map<string, string>()
  for (const part of chunks(ids)) {
    const rows = await db
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.user)
      .where(inArray(schema.user.id, part))
    for (const r of rows) names.set(r.id, r.name)
  }
  return versions.map((v) =>
    v.pushedBy === undefined ? v : { ...v, pushedByName: names.get(v.pushedBy ?? '') ?? null },
  )
}

export function collectionRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/api/context', async (c) => {
    const { db } = c.var.ports
    const p = c.var.principal
    let currentUser = null
    if (p && p.scope === 'session') {
      const { cache, waitUntil } = c.var.ports
      // At once: each is a round trip, and the profile may wait on KF Auth.
      const [[u], orgs, profile] = await Promise.all([
        db.select().from(schema.user).where(eq(schema.user.id, p.userId)).limit(1),
        db
          .select({ org: schema.organization, role: schema.member.role })
          .from(schema.member)
          .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
          .where(eq(schema.member.userId, p.userId)),
        // The role decides steward pages; name and picture follow KF Auth (v1).
        c.var.kf?.profile(p.userId, { cache, waitUntil }) ?? null,
      ])
      if (u) {
        currentUser = {
          id: u.id,
          email: u.email,
          displayName: profile?.name ?? u.name ?? null,
          avatarUrl: profile?.image ?? u.image ?? null,
          kfRole: profile?.role ?? null,
          orgs: orgs.map((o) => ({
            organizationId: o.org.id,
            slug: o.org.slug,
            displayName: o.org.name,
            role: o.role,
          })),
        }
      }
    }
    return c.json({
      currentUser,
      kfAccountUrl: c.var.config.kfAccountUrl ?? '',
      kfAuthUrl: c.var.config.kfAuthUrl ?? '',
      // The deployment's host, for "this becomes the URL" hints.
      siteHost: new URL(c.var.config.appUrl).host,
    })
  })

  app.get('/api/collections', async (c) => {
    const { db } = c.var.ports
    const p = c.var.principal
    const q = c.req.query('q')
    const owner = c.req.query('owner')
    const tag = c.req.query('tag')
    const sort = c.req.query('sort')
    const mine = c.req.query('mine') === 'true'
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50) || 50))
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    const scoped = !!p?.collectionIds
    if (mine && (!p || scoped))
      return jsonError(c, 401, 'Unauthorized — mine=true requires a session')
    const orgIds = await memberOrgIds(db, p)

    // A subquery, not the list: D1 binds at most 100 parameters per statement.
    const myOrgs = db
      .select({ id: schema.member.organizationId })
      .from(schema.member)
      .where(
        and(
          eq(schema.member.userId, p?.userId ?? ''),
          p?.onlyOrgId ? eq(schema.member.organizationId, p.onlyOrgId) : undefined,
        ),
      )
    const visible = mine
      ? inArray(schema.collections.organizationId, myOrgs)
      : eq(schema.collections.public, true)
    const conds = [visible, sql`${schema.collections.deletedAt} IS NULL`]
    // A search matches a collection's name, slug or description, or its owner's name or slug.
    const search = q?.trim().slice(0, 100)
    const pattern = search ? `%${search}%` : ''
    const ownerMatches = sql`(${schema.organization.name} LIKE ${pattern} OR ${schema.organization.slug} LIKE ${pattern})`
    if (search) {
      conds.push(
        sql`(${schema.collections.name} LIKE ${pattern} OR ${schema.collections.slug} LIKE ${pattern}
          OR json_extract(${schema.collections.summary}, '$.description') LIKE ${pattern}
          OR ${ownerMatches})`,
      )
    }
    if (owner) conds.push(eq(schema.organization.slug, owner))
    if (tag) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM json_each(${schema.collections.summary}, '$.tags') WHERE value = ${tag})`,
      )
    }
    const where = and(...conds)
    const order =
      sort === 'name'
        ? [asc(schema.collections.name)]
        : sort === 'records'
          ? [desc(schema.versions.publicRecordCount)]
          : [desc(schema.collections.updatedAt)]

    const rows = await db
      .select({ c: schema.collections, owner: schema.organization, v: schema.versions })
      .from(schema.collections)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
      .leftJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset)

    const item = (r: (typeof rows)[number]) => {
      const isOwner = orgIds.includes(r.c.organizationId)
      const v = r.v ? versionSummary(r.v, isOwner) : null
      return {
        id: r.c.id,
        slug: r.c.slug,
        name: r.c.name,
        public: r.c.public,
        ownerSlug: r.owner.slug,
        ownerName: r.owner.name,
        createdAt: r.c.createdAt,
        updatedAt: r.c.updatedAt,
        description: r.c.summary?.description ?? null,
        tags: r.c.summary?.tags ?? [],
        latestVersion: v?.semver ?? null,
        recordCount: v?.recordCount ?? null,
        fileCount: v?.fileCount ?? null,
        totalBytes: v?.totalBytes ?? null,
        lastPushAt: v?.createdAt ?? null,
      }
    }

    // Facets over everything visible (not just this page).
    const ownerFacets = await db
      .select({ slug: schema.organization.slug, name: schema.organization.name, count: count() })
      .from(schema.collections)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
      .where(and(visible, sql`${schema.collections.deletedAt} IS NULL`))
      .groupBy(schema.organization.id)
      .orderBy(desc(count()))
      .limit(50)
    const tagFacets = (await db.all(sql`
      SELECT t.value AS name, count(*) AS count
      FROM ${schema.collections} c, json_each(c.summary, '$.tags') t
      WHERE ${mine ? inArray(sql`c.organization_id`, myOrgs) : sql`c.public = 1`}
        AND c.deleted_at IS NULL
      GROUP BY t.value ORDER BY count DESC LIMIT 50
    `)) as { name: string; count: number }[]

    // Organizations whose name or slug matches the search, among those with a collection in view.
    const organizations = search
      ? await db
          .select({
            slug: schema.organization.slug,
            name: schema.organization.name,
            avatarUrl: schema.organization.avatarUrl,
            count: count(),
          })
          .from(schema.collections)
          .innerJoin(
            schema.organization,
            eq(schema.organization.id, schema.collections.organizationId),
          )
          .where(and(visible, sql`${schema.collections.deletedAt} IS NULL`, ownerMatches))
          .groupBy(schema.organization.id)
          .orderBy(desc(count()))
          .limit(24)
      : []

    const settings = await db
      .select()
      .from(schema.instanceSettings)
      .where(
        inArray(schema.instanceSettings.key, [
          'explore_featured_tags',
          'explore_featured_collections',
        ]),
      )
    const setting = (k: string) => settings.find((s) => s.key === k)?.value
    const featuredTags = Array.isArray(setting('explore_featured_tags'))
      ? (setting('explore_featured_tags') as string[])
      : []
    const featuredRefs = Array.isArray(setting('explore_featured_collections'))
      ? (setting('explore_featured_collections') as string[])
      : []
    let featuredCollections: ReturnType<typeof item>[] = []
    if (featuredRefs.length > 0) {
      const pairs = featuredRefs.map((r) => r.split('/')).filter((x) => x.length === 2)
      const featured = await db
        .select({ c: schema.collections, owner: schema.organization, v: schema.versions })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.organization.id, schema.collections.organizationId),
        )
        .leftJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
        .where(
          and(
            eq(schema.collections.public, true),
            or(
              ...pairs.map(([o, s]) =>
                and(eq(schema.organization.slug, o!), eq(schema.collections.slug, s!)),
              ),
            ),
          ),
        )
      featuredCollections = featuredRefs
        .map((ref) => featured.find((f) => `${f.owner.slug}/${f.c.slug}` === ref))
        .filter((f): f is (typeof featured)[number] => !!f)
        .map(item)
    }

    return c.json({
      collections: rows.map(item),
      facets: { owners: ownerFacets, tags: tagFacets },
      organizations,
      featuredTags,
      featuredCollections,
    })
  })

  app.get('/api/collections/:owner/:slug', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const { db } = c.var.ports
    const col = access.collection
    const ark = await collectionArk(db, col.id, access.owner)
    const [versionCount] = await db
      .select({ n: count() })
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, col.id))
    let latestVersion = null
    let head: { semver: string; hash: string } | null = null
    if (col.headVersionId) {
      const [v] = await db
        .select()
        .from(schema.versions)
        .where(eq(schema.versions.id, col.headVersionId))
        .limit(1)
      if (v) {
        head = { semver: v.semver, hash: v.hash }
        const metadata =
          col.recordLayout === 'v3'
            ? await metadataOf(readStore(c.var.ports), await readView(c.var.ports, col.id, v))
            : (await (await c.var.ports.stores.forCollection(col.id)).root(v.hash)).metadata
        const s = (await withPusherNames(db, [versionSummary(v, access.isMember, ark)]))[0]!
        latestVersion = {
          ...s,
          metadata,
          typeCounts: Object.entries(s.typeCounts).map(([type, n]) => ({ type, count: n })),
        }
      }
    }
    // The standard members (spec 11.3.3) mirror collection.json; `public`,
    // `ownerSlug`, `ownerName` and `latestVersion` are v1's, which the UI reads.
    return c.json({
      id: col.id,
      owner: {
        id: access.owner.id,
        did: null,
        handle: access.owner.slug,
        name: access.owner.name,
      },
      slug: col.slug,
      name: col.name,
      description: col.summary?.description ?? null,
      visibility: col.public ? 'public' : 'private',
      ark: ark ? ark() : null,
      createdAt: col.createdAt,
      updatedAt: col.updatedAt,
      versionCount: versionCount?.n ?? 0,
      head,
      public: col.public,
      ownerSlug: access.owner.slug,
      ownerName: access.owner.name,
      latestVersion,
    })
  })

  // An org's collections for its page: what each holds at its head version, as the
  // explore list shows it, and `pinned`, its place among the org's pinned collections.
  app.get('/api/accounts/:owner/collections', async (c) => {
    const { db } = c.var.ports
    const p = c.var.principal
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, c.req.param('owner')))
      .limit(1)
    if (!org) return c.json([])
    const orgIds = await memberOrgIds(db, p)
    const member = orgIds.includes(org.id)
    const rows = await db
      .select({ c: schema.collections, v: schema.versions })
      .from(schema.collections)
      .leftJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
      .where(
        and(
          eq(schema.collections.organizationId, org.id),
          sql`${schema.collections.deletedAt} IS NULL`,
          member ? undefined : eq(schema.collections.public, true),
        ),
      )
      .orderBy(desc(schema.collections.updatedAt))
    const pinned = org.pinned ?? []
    return c.json(
      rows.map((r) => {
        const v = r.v ? versionSummary(r.v, member) : null
        const at = pinned.indexOf(r.c.id)
        return {
          id: r.c.id,
          slug: r.c.slug,
          name: r.c.name,
          public: r.c.public,
          createdAt: r.c.createdAt,
          updatedAt: r.c.updatedAt,
          description: r.c.summary?.description ?? null,
          tags: r.c.summary?.tags ?? [],
          license: r.c.summary?.license ?? null,
          latestVersion: v?.semver ?? null,
          recordCount: v?.recordCount ?? null,
          totalBytes: v?.totalBytes ?? null,
          typeCounts: v?.typeCounts ?? null,
          lastPushAt: v?.createdAt ?? null,
          pinned: at >= 0 ? at : null,
        }
      }),
    )
  })

  // Recent versions across the org's collections the caller may see, newest first.
  app.get('/api/accounts/:slug/activity', async (c) => {
    const { db } = c.var.ports
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, c.req.param('slug')))
      .limit(1)
    if (!org) return jsonError(c, 404, 'Not found')
    const member = (await memberOrgIds(db, c.var.principal)).includes(org.id)
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20) || 20))
    const rows = await db
      .select({
        slug: schema.collections.slug,
        name: schema.collections.name,
        v: schema.versions,
      })
      .from(schema.versions)
      .innerJoin(schema.collections, eq(schema.collections.id, schema.versions.collectionId))
      .where(
        and(
          eq(schema.collections.organizationId, org.id),
          sql`${schema.collections.deletedAt} IS NULL`,
          member ? undefined : eq(schema.collections.public, true),
        ),
      )
      .orderBy(desc(schema.versions.createdAt))
      .limit(limit)
    return c.json(
      rows.map((r) => ({
        collectionSlug: r.slug,
        collectionName: r.name,
        semver: r.v.semver,
        message: r.v.message,
        recordCount: member ? r.v.recordCount : r.v.publicRecordCount,
        createdAt: r.v.createdAt,
      })),
    )
  })

  app.get('/api/accounts/:slug', async (c) => {
    const { db } = c.var.ports
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, c.req.param('slug')))
      .limit(1)
    if (!org) return jsonError(c, 404, 'Not found')
    const [shoulder] = await db
      .select({ shoulder: schema.arkShoulders.shoulder })
      .from(schema.arkShoulders)
      .where(eq(schema.arkShoulders.organizationId, org.id))
      .limit(1)
    // Pinned collections the caller may see: a private one's id stays with the members.
    let pinned = org.pinned ?? []
    if (pinned.length && !(await memberOrgIds(db, c.var.principal)).includes(org.id)) {
      const open = await db
        .select({ id: schema.collections.id })
        .from(schema.collections)
        .where(
          and(
            inArray(schema.collections.id, pinned),
            eq(schema.collections.public, true),
            sql`${schema.collections.deletedAt} IS NULL`,
          ),
        )
      const ids = new Set(open.map((r) => r.id))
      pinned = pinned.filter((id) => ids.has(id))
    }
    // Public profile only (v1 returned the whole row, including kfOrgId).
    return c.json({
      id: org.id,
      name: org.name,
      slug: org.slug,
      displayName: org.name,
      avatarUrl: org.avatarUrl,
      logo: org.logo,
      bio: org.bio,
      website: org.website,
      tagline: org.tagline,
      location: org.location,
      coverColor: org.coverColor,
      provenanceNote: org.provenanceNote,
      pinned,
      createdAt: org.createdAt,
      arkNaan: org.arkNaan,
      arkShoulder: shoulder?.shoulder ?? null,
    })
  })

  // Members: the org's own members see everyone and their roles; anyone else sees only
  // those who chose to be listed, by name (GitHub's rule). A key limited to another org,
  // or confined to some collections, reads as an outsider.
  app.get('/api/accounts/:slug/members', async (c) => {
    const { db } = c.var.ports
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, c.req.param('slug')))
      .limit(1)
    if (!org) return jsonError(c, 404, 'Not found')
    const members = await db
      .select({
        userId: schema.member.userId,
        role: schema.member.role,
        name: schema.user.name,
        publicMembership: schema.member.publicMembership,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, org.id))
    const p = c.var.principal
    const inside =
      !!p &&
      !p.collectionIds &&
      reachesOrg(p, org.id) &&
      (p.orgId === org.id || members.some((m) => m.userId === p.userId))
    if (!inside) {
      return c.json(members.filter((m) => m.publicMembership).map((m) => ({ displayName: m.name })))
    }
    return c.json(
      members.map((m) => ({
        role: m.role,
        displayName: m.name,
        public: m.publicMembership,
        you: m.userId === p.userId,
      })),
    )
  })

  // A member shows or hides their own membership on the org's public page.
  app.put('/api/accounts/:slug/members/me', async (c) => {
    const p = c.var.principal
    if (!p) return jsonError(c, 401, 'Authentication required')
    if (p.orgId) return jsonError(c, 403, "An organization's key is not a member")
    const { org, role } = await membership(c, c.req.param('slug'))
    if (!org) return jsonError(c, 404, 'Not found')
    if (!role) return jsonError(c, 403, 'Forbidden')
    const body = (await c.req.json().catch(() => null)) as { public?: unknown } | null
    if (typeof body?.public !== 'boolean')
      return jsonError(c, 400, '"public" must be true or false')
    await c.var.ports.db
      .update(schema.member)
      .set({ publicMembership: body.public })
      .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, p.userId)))
    return c.json({ public: body.public })
  })

  return app
}
