/**
 * Steward pages, protocol discussion and the KF dashboard summary (v1's
 * `server.ts` explore routes, `src/api/discussion.ts` and `src/api/kf-summary.ts`):
 *
 *   GET|PUT /api/admin/explore-tags              {tags: string[]}             stewards
 *   GET|PUT /api/admin/explore-collections       {collections: "owner/slug"[]} stewards
 *   GET     /api/pages/:page/comments            approved, plus the caller's own
 *   POST    /api/pages/:page/comments            {anchor, body, quote?, quoteContext?, parentId?}
 *   PATCH   /api/pages/:page/comments/:id        author: body; steward: approve, status, note
 *   DELETE  /api/pages/:page/comments/:id        author or steward
 *   GET     /api/admin/discussion                stewards: pending and all threads
 *   GET     /api/kf/summary?kf_org_id=           KF Auth, with the internal API key
 *
 * A steward is a KF Auth user whose role is 'admin', read fresh on each check.
 */
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { jsonError } from './access.js'

const COMMENT_MAX = 8192
/** Comments per user per minute (v1: 10, held in process memory). */
const COMMENTS_PER_MINUTE = 10
const STATUSES = ['open', 'answered', 'decided', 'changed'] as const

/** The signed-in person (session or unscoped key), as v1's requireAuth + requireUnscopedKey. */
function person(c: Context<AppEnv>, write: boolean): string | null {
  const p = c.var.principal
  if (!p || p.collectionIds || p.orgId) return null
  if (write && p.scope === 'read') return null
  return p.userId
}

async function isSteward(c: Context<AppEnv>, userId: string | null): Promise<boolean> {
  return !!userId && (await c.var.kf?.role(userId)) === 'admin'
}

/** 401/403 unless the caller is a steward; null when they are. */
async function stewardOnly(c: Context<AppEnv>): Promise<Response | null> {
  const userId = person(c, false)
  if (!userId) return jsonError(c, 401, 'Unauthorized')
  return (await isSteward(c, userId)) ? null : jsonError(c, 403, 'Forbidden')
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string')

async function readSetting(c: Context<AppEnv>, key: string): Promise<unknown> {
  const [row] = await c.var.ports.db
    .select({ value: schema.instanceSettings.value })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, key))
    .limit(1)
  return row?.value
}

async function writeSetting(c: Context<AppEnv>, key: string, value: unknown) {
  await c.var.ports.db
    .insert(schema.instanceSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.instanceSettings.key,
      set: { value, updatedAt: new Date() },
    })
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined)

export function adminRoutes() {
  const app = new Hono<AppEnv>()

  for (const [path, key, field, hint] of [
    [
      '/api/admin/explore-tags',
      'explore_featured_tags',
      'tags',
      'tags must be an array of strings',
    ],
    [
      '/api/admin/explore-collections',
      'explore_featured_collections',
      'collections',
      'collections must be an array of "owner/slug" strings',
    ],
  ] as const) {
    app.get(path, async (c) => {
      const denied = await stewardOnly(c)
      if (denied) return denied
      const value = await readSetting(c, key)
      return c.json({ [field]: isStrings(value) ? value : [] })
    })
    app.put(path, async (c) => {
      const denied = await stewardOnly(c)
      if (denied) return denied
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
      const value = body?.[field]
      if (!isStrings(value)) return jsonError(c, 422, hint)
      await writeSetting(c, key, value)
      return c.json({ ok: true, [field]: value })
    })
  }

  app.get('/api/pages/:page/comments', async (c) => {
    const userId = person(c, false)
    const t = schema.pageComments
    const rows = await c.var.ports.db
      .select({
        id: t.id,
        page: t.page,
        anchor: t.anchor,
        quote: t.quote,
        quoteContext: t.quoteContext,
        parentId: t.parentId,
        userId: t.userId,
        body: t.body,
        approvedAt: t.approvedAt,
        status: t.status,
        resolutionNote: t.resolutionNote,
        createdAt: t.createdAt,
        editedAt: t.editedAt,
        authorName: schema.user.name,
        authorImage: schema.user.image,
      })
      .from(t)
      .innerJoin(schema.user, eq(schema.user.id, t.userId))
      .where(
        and(
          eq(t.page, c.req.param('page')),
          isNull(t.deletedAt),
          userId ? or(isNotNull(t.approvedAt), eq(t.userId, userId)) : isNotNull(t.approvedAt),
        ),
      )
      .orderBy(t.createdAt)
    const comments: Record<string, typeof rows> = {}
    for (const r of rows) (comments[r.anchor] ??= []).push(r)
    return c.json({ comments })
  })

  app.post('/api/pages/:page/comments', async (c) => {
    const userId = person(c, true)
    if (!userId) return jsonError(c, 401, 'Authentication required')
    const { db } = c.var.ports
    const t = schema.pageComments
    const [recent] = await db
      .select({ n: count() })
      .from(t)
      .where(and(eq(t.userId, userId), gt(t.createdAt, new Date(Date.now() - 60_000))))
    if ((recent?.n ?? 0) >= COMMENTS_PER_MINUTE) {
      return c.json({ error: 'Rate limit exceeded', statusCode: 429 }, 429)
    }
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const anchor = str(b?.anchor, 200)
    const body = str(b?.body, COMMENT_MAX)
    const quote = b?.quote === undefined ? null : str(b.quote, 2000)
    const qc = b?.quoteContext as { prefix?: unknown; suffix?: unknown } | undefined
    const quoteContext =
      qc === undefined
        ? null
        : str(qc?.prefix, 200) !== undefined && str(qc?.suffix, 200) !== undefined
          ? { prefix: qc.prefix as string, suffix: qc.suffix as string }
          : undefined
    const parentId = b?.parentId === undefined ? null : str(b.parentId, 64)
    if (
      !anchor ||
      !body ||
      quote === undefined ||
      quoteContext === undefined ||
      parentId === undefined
    ) {
      return jsonError(c, 400, 'Invalid request')
    }
    if (parentId) {
      const [parent] = await db
        .select({ parentId: t.parentId })
        .from(t)
        .where(and(eq(t.id, parentId), eq(t.page, c.req.param('page')), isNull(t.deletedAt)))
        .limit(1)
      if (!parent) return jsonError(c, 404, 'Parent comment not found')
      if (parent.parentId) return jsonError(c, 400, 'Cannot nest replies deeper than one level')
    }
    const [comment] = await db
      .insert(t)
      .values({ page: c.req.param('page'), anchor, quote, quoteContext, parentId, userId, body })
      .returning()
    return c.json({ comment }, 201)
  })

  app.patch('/api/pages/:page/comments/:id', async (c) => {
    const userId = person(c, true)
    if (!userId) return jsonError(c, 401, 'Authentication required')
    const t = schema.pageComments
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const body = b.body === undefined ? undefined : str(b.body, COMMENT_MAX)
    const note = b.resolutionNote === undefined ? undefined : str(b.resolutionNote, 2000)
    const status = STATUSES.find((s) => s === b.status)
    if (
      (b.body !== undefined && !body) ||
      (b.resolutionNote !== undefined && note === undefined) ||
      (b.status !== undefined && !status) ||
      (b.approve !== undefined && typeof b.approve !== 'boolean')
    ) {
      return jsonError(c, 400, 'Invalid request')
    }
    const [existing] = await c.var.ports.db
      .select()
      .from(t)
      .where(and(eq(t.id, c.req.param('id')), isNull(t.deletedAt)))
      .limit(1)
    if (!existing) return jsonError(c, 404, 'Comment not found')
    const steward = await isSteward(c, userId)
    if (body) {
      if (existing.userId !== userId) {
        return jsonError(c, 403, "Cannot edit another user's comment")
      }
      if (existing.approvedAt && !steward) {
        return jsonError(c, 403, 'Cannot edit an approved comment')
      }
    }
    if ((b.approve !== undefined || status || note !== undefined) && !steward) {
      return jsonError(c, 403, 'Steward access required')
    }
    const set: Partial<typeof t.$inferInsert> = {}
    if (body) Object.assign(set, { body, editedAt: new Date() })
    if (b.approve === true) Object.assign(set, { approvedAt: new Date(), approvedBy: userId })
    if (status) set.status = status
    if (note !== undefined) set.resolutionNote = note
    if (!Object.keys(set).length) return jsonError(c, 400, 'No changes')
    const [comment] = await c.var.ports.db
      .update(t)
      .set(set)
      .where(eq(t.id, existing.id))
      .returning()
    return c.json({ comment })
  })

  app.delete('/api/pages/:page/comments/:id', async (c) => {
    const userId = person(c, true)
    if (!userId) return jsonError(c, 401, 'Authentication required')
    const t = schema.pageComments
    const [existing] = await c.var.ports.db
      .select({ id: t.id, userId: t.userId })
      .from(t)
      .where(and(eq(t.id, c.req.param('id')), isNull(t.deletedAt)))
      .limit(1)
    if (!existing) return jsonError(c, 404, 'Comment not found')
    if (existing.userId !== userId && !(await isSteward(c, userId))) {
      return jsonError(c, 403, 'Forbidden')
    }
    await c.var.ports.db.update(t).set({ deletedAt: new Date() }).where(eq(t.id, existing.id))
    return c.json({ ok: true })
  })

  app.get('/api/admin/discussion', async (c) => {
    const userId = person(c, true)
    if (!userId) return jsonError(c, 401, 'Authentication required')
    if (!(await isSteward(c, userId))) return jsonError(c, 403, 'Steward access required')
    const t = schema.pageComments
    const { db } = c.var.ports
    const pending = await db
      .select({
        id: t.id,
        page: t.page,
        anchor: t.anchor,
        quote: t.quote,
        body: t.body,
        createdAt: t.createdAt,
        authorName: schema.user.name,
        authorImage: schema.user.image,
      })
      .from(t)
      .innerJoin(schema.user, eq(schema.user.id, t.userId))
      .where(and(isNull(t.approvedAt), isNull(t.deletedAt)))
      .orderBy(t.createdAt)
    const threads = await db
      .select({
        id: t.id,
        page: t.page,
        anchor: t.anchor,
        quote: t.quote,
        body: t.body,
        status: t.status,
        resolutionNote: t.resolutionNote,
        approvedAt: t.approvedAt,
        createdAt: t.createdAt,
        authorName: schema.user.name,
      })
      .from(t)
      .innerJoin(schema.user, eq(schema.user.id, t.userId))
      .where(and(isNull(t.deletedAt), isNull(t.parentId)))
      .orderBy(desc(t.createdAt))
    return c.json({ pending, threads })
  })

  app.get('/api/kf/summary', async (c) => {
    const kfOrgId = c.req.query('kf_org_id')
    if (!kfOrgId) return jsonError(c, 400, 'kf_org_id is required')
    if (!c.var.kf?.isInternalCall(c.req.header('authorization'))) {
      return jsonError(c, 401, 'Unauthorized')
    }
    const { db } = c.var.ports
    const appUrl = c.var.config.appUrl
    const orgs = await db
      .select({
        id: schema.organization.id,
        slug: schema.organization.slug,
        name: schema.organization.name,
      })
      .from(schema.organization)
      .where(eq(schema.organization.kfOrgId, kfOrgId))
    if (!orgs.length) return c.json({ orgs: [] })
    const cols: {
      id: string
      slug: string
      name: string
      organizationId: string
    }[] = []
    for (const part of chunks(orgs.map((o) => o.id))) {
      cols.push(
        ...(await db
          .select({
            id: schema.collections.id,
            slug: schema.collections.slug,
            name: schema.collections.name,
            organizationId: schema.collections.organizationId,
          })
          .from(schema.collections)
          .where(
            and(
              inArray(schema.collections.organizationId, part),
              isNull(schema.collections.deletedAt),
            ),
          )),
      )
    }
    // As v1: sums over the collection's versions (every v2 row is a published one).
    const stats = new Map<
      string,
      { versions: number; records: number; files: number; bytes: number }
    >()
    const v = schema.versions
    for (const part of chunks(cols.map((x) => x.id))) {
      const rows = await db
        .select({
          collectionId: v.collectionId,
          versions: count(),
          records: sql<number>`coalesce(sum(${v.recordCount}), 0)`,
          files: sql<number>`coalesce(sum(${v.fileCount}), 0)`,
          bytes: sql<number>`coalesce(sum(${v.totalBytes}), 0)`,
        })
        .from(v)
        .where(inArray(v.collectionId, part))
        .groupBy(v.collectionId)
      for (const r of rows) {
        stats.set(r.collectionId, {
          versions: r.versions,
          records: Number(r.records),
          files: Number(r.files),
          bytes: Number(r.bytes),
        })
      }
    }
    return c.json({
      orgs: orgs.map((o) => ({
        id: o.id,
        slug: o.slug,
        name: o.name ?? o.slug,
        url: `${appUrl}/${o.slug}`,
        collections: cols
          .filter((x) => x.organizationId === o.id)
          .map((x) => ({
            id: x.id,
            name: x.name,
            slug: x.slug,
            url: `${appUrl}/${o.slug}/${x.slug}`,
            stats: stats.get(x.id) ?? { versions: 0, records: 0, files: 0, bytes: 0 },
          })),
      })),
    })
  })

  return app
}
