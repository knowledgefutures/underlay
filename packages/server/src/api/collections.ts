/**
 * Collection, account and app-context reads (v1 shapes: docs/v1-read-api.md).
 *
 *   GET /api/context
 *   GET /api/collections                       list and explore
 *   GET /api/collections/:owner/:slug          detail
 *   GET /api/accounts/:owner/collections
 *   GET /api/accounts/:slug, /api/accounts/:slug/members
 *
 * Everything here is SQLite rows: no repository reads. Lists show what a
 * caller may see: public counts to non-members, full counts to members.
 */
import { and, asc, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'
import { jsonError, requireCollection } from './access.js'
import { collectionArk } from './ark.js'

type VersionRow = typeof schema.versions.$inferSelect

/** Org ids the principal belongs to (empty for anonymous or collection-scoped keys). */
async function memberOrgIds(
  db: Db,
  userId: string | undefined,
  scoped: boolean,
): Promise<string[]> {
  if (!userId || scoped) return []
  const rows = await db
    .select({ id: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
  return rows.map((r) => r.id)
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
      const [u] = await db.select().from(schema.user).where(eq(schema.user.id, p.userId)).limit(1)
      if (u) {
        const orgs = await db
          .select({ org: schema.organization, role: schema.member.role })
          .from(schema.member)
          .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
          .where(eq(schema.member.userId, u.id))
        const def = orgs.find((o) => o.org.isDefault) ?? null
        // The role decides steward pages; name and picture follow KF Auth (v1).
        const profile = (await c.var.kf?.profile(u.id)) ?? null
        currentUser = {
          id: u.id,
          slug: def?.org.slug ?? null,
          displayName: profile?.name ?? u.name ?? def?.org.name ?? null,
          avatarUrl: profile?.image ?? u.image ?? null,
          kfRole: profile?.role ?? null,
          defaultOrg: def ? { slug: def.org.slug, displayName: def.org.name } : null,
          orgs: orgs.map((o) => ({
            organizationId: o.org.id,
            slug: o.org.slug,
            displayName: o.org.name,
            role: o.role,
            isDefault: o.org.isDefault,
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
    const orgIds = await memberOrgIds(db, p?.userId, scoped)

    // A subquery, not the list: D1 binds at most 100 parameters per statement.
    const myOrgs = db
      .select({ id: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, p?.userId ?? ''))
    const visible = mine
      ? inArray(schema.collections.organizationId, myOrgs)
      : eq(schema.collections.public, true)
    const conds = [visible, sql`${schema.collections.deletedAt} IS NULL`]
    if (q) conds.push(like(schema.collections.name, `%${q}%`))
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
    if (col.headVersionId) {
      const [v] = await db
        .select()
        .from(schema.versions)
        .where(eq(schema.versions.id, col.headVersionId))
        .limit(1)
      if (v) {
        const repo = await c.var.ports.stores.forCollection(col.id)
        const root = await repo.root(v.hash)
        const s = (await withPusherNames(db, [versionSummary(v, access.isMember, ark)]))[0]!
        latestVersion = {
          ...s,
          metadata: root.metadata,
          typeCounts: Object.entries(s.typeCounts).map(([type, n]) => ({ type, count: n })),
        }
      }
    }
    return c.json({
      id: col.id,
      slug: col.slug,
      name: col.name,
      public: col.public,
      ownerSlug: access.owner.slug,
      ownerName: access.owner.name,
      createdAt: col.createdAt,
      updatedAt: col.updatedAt,
      description: col.summary?.description ?? null,
      ark: ark ? ark() : null,
      versionCount: versionCount?.n ?? 0,
      latestVersion,
    })
  })

  app.get('/api/accounts/:owner/collections', async (c) => {
    const { db } = c.var.ports
    const p = c.var.principal
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, c.req.param('owner')))
      .limit(1)
    if (!org) return c.json([])
    const orgIds = await memberOrgIds(db, p?.userId, !!p?.collectionIds)
    const member = orgIds.includes(org.id)
    const rows = await db
      .select({
        id: schema.collections.id,
        slug: schema.collections.slug,
        name: schema.collections.name,
        public: schema.collections.public,
        createdAt: schema.collections.createdAt,
        updatedAt: schema.collections.updatedAt,
      })
      .from(schema.collections)
      .where(
        and(
          eq(schema.collections.organizationId, org.id),
          sql`${schema.collections.deletedAt} IS NULL`,
          member ? undefined : eq(schema.collections.public, true),
        ),
      )
      .orderBy(desc(schema.collections.updatedAt))
    return c.json(rows)
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
      createdAt: org.createdAt,
      isDefault: org.isDefault,
      arkNaan: org.arkNaan,
      arkShoulder: shoulder?.shoulder ?? null,
    })
  })

  app.get('/api/accounts/:slug/members', async (c) => {
    const { db } = c.var.ports
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, c.req.param('slug')))
      .limit(1)
    if (!org) return jsonError(c, 404, 'Not found')
    const members = await db
      .select({ role: schema.member.role, userId: schema.member.userId, name: schema.user.name })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, org.id))
    const defaults: { userId: string; slug: string }[] = []
    for (const part of chunks(members.map((m) => m.userId))) {
      defaults.push(
        ...(await db
          .select({ userId: schema.member.userId, slug: schema.organization.slug })
          .from(schema.member)
          .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
          .where(
            and(inArray(schema.member.userId, part), eq(schema.organization.isDefault, true)),
          )),
      )
    }
    return c.json(
      members.map((m) => ({
        role: m.role,
        slug: defaults.find((d) => d.userId === m.userId)?.slug ?? null,
        displayName: m.name,
      })),
    )
  })

  return app
}
