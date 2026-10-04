/**
 * Steward pages and the KF dashboard summary (v1's `server.ts` explore routes
 * and `src/api/kf-summary.ts`):
 *
 *   GET|PUT /api/admin/explore-tags              {tags: string[]}             stewards
 *   GET|PUT /api/admin/explore-collections       {collections: "owner/slug"[]} stewards
 *   GET     /api/kf/summary?kf_org_id=           KF Auth, with the internal API key
 *   POST    /api/abuse-reports                   {hash?, url?, reason, contact?}: anyone
 *   GET     /api/admin/abuse-reports             stewards: ?status=open|blocked|dismissed
 *   PATCH   /api/admin/abuse-reports/:id         stewards: {status: 'dismissed'|'open'}
 *   GET     /api/admin/denylist                  stewards
 *   POST    /api/admin/denylist                  stewards: {hash, kind, reason, reportId?}
 *   DELETE  /api/admin/denylist/:hash            stewards
 *   POST    /api/admin/reconcile                 stewards: {collection: "owner/slug"} starts a run
 *   GET     /api/admin/reconcile?collection=     stewards: the last run's time and report
 *   GET     /api/admin/usage?day=&account=       stewards: a day's usage rollups
 *   POST    /api/admin/fsck                      stewards: {collection, fileBytes?} checks its repository
 *   GET     /api/admin/fsck?collection=          stewards: the last check's report
 *   POST    /api/admin/usage/rebuild             stewards: {day} recomputes them from the usage log
 *
 * A steward is a KF Auth user whose role is 'admin', read fresh on each check.
 */
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { usageFor } from '../billing/usage.js'
import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { forgetDenylist } from '../lib/limits.js'
import { jsonError } from './access.js'

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
export async function stewardOnly(c: Context<AppEnv>): Promise<Response | null> {
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

  const collectionBySlugs = async (c: Context<AppEnv>, ref: unknown) => {
    const [owner, slug] = typeof ref === 'string' ? ref.split('/') : []
    if (!owner || !slug) return null
    const [row] = await c.var.ports.db
      .select({ c: schema.collections })
      .from(schema.collections)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
      .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    return row?.c ?? null
  }

  app.post('/api/admin/reconcile', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const b = (await c.req.json().catch(() => null)) as { collection?: unknown } | null
    const col = await collectionBySlugs(c, b?.collection)
    if (!col) return jsonError(c, 404, 'Collection not found (send {"collection": "owner/slug"})')
    await c.var.ports.jobs.enqueue({ type: 'reconcile.collection', collectionId: col.id })
    return c.json({ ok: true, queued: true }, 202)
  })

  app.get('/api/admin/reconcile', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const col = await collectionBySlugs(c, c.req.query('collection'))
    if (!col) return jsonError(c, 404, 'Collection not found (?collection=owner/slug)')
    return c.json({
      startedAt: col.reconcileStartedAt,
      reconciledAt: col.reconciledAt,
      running:
        !!col.reconcileStartedAt &&
        !(col.reconciledAt && col.reconciledAt >= col.reconcileStartedAt),
      report: col.reconcileReport ?? [],
    })
  })

  app.post('/api/admin/fsck', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const b = (await c.req.json().catch(() => null)) as {
      collection?: unknown
      fileBytes?: unknown
    } | null
    const col = await collectionBySlugs(c, b?.collection)
    if (!col) return jsonError(c, 404, 'Collection not found (send {"collection": "owner/slug"})')
    await c.var.ports.jobs.enqueue({
      type: 'repo.fsck',
      collectionId: col.id,
      fileBytes: b?.fileBytes === true,
    })
    return c.json({ ok: true, queued: true }, 202)
  })

  app.get('/api/admin/fsck', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const col = await collectionBySlugs(c, c.req.query('collection'))
    if (!col) return jsonError(c, 404, 'Collection not found (?collection=owner/slug)')
    const obj = await c.var.ports.stores.internal.get(`fsck/${col.id}.json`)
    if (!obj) return jsonError(c, 404, 'Not checked yet')
    return c.json(JSON.parse(await obj.text()))
  })

  const DAY = /^\d{4}-\d{2}-\d{2}$/
  app.get('/api/admin/usage', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const day = c.req.query('day') ?? ''
    if (!DAY.test(day)) return jsonError(c, 400, 'day must be YYYY-MM-DD')
    return c.json({ day, rollups: await usageFor(c.var.ports, day, c.req.query('account')) })
  })

  app.post('/api/admin/usage/rebuild', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const b = (await c.req.json().catch(() => null)) as { day?: unknown } | null
    if (typeof b?.day !== 'string' || !DAY.test(b.day))
      return jsonError(c, 400, 'day must be YYYY-MM-DD')
    await c.var.ports.jobs.enqueue({ type: 'usage.rebuild', day: b.day })
    return c.json({ ok: true, queued: true }, 202)
  })

  app.post('/api/abuse-reports', async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const hash = b?.hash === undefined || b.hash === '' ? null : str(b.hash, 80)
    const url = b?.url === undefined || b.url === '' ? null : str(b.url, 2000)
    const reason = str(b?.reason, 4000)?.trim()
    const contact = b?.contact === undefined || b.contact === '' ? null : str(b.contact, 320)
    if (hash === undefined || url === undefined || contact === undefined || !reason) {
      return jsonError(c, 400, 'A reason is required; hash, url and contact are optional strings')
    }
    if (!hash && !url) return jsonError(c, 400, 'Name the content: a hash or a url')
    const cleanHash = hash?.replace(/^sha256:/, '') ?? null
    if (cleanHash && !/^[0-9a-f]{64}$/.test(cleanHash)) {
      return jsonError(c, 400, 'hash must be 64 hex characters (a file or record hash)')
    }
    const [report] = await c.var.ports.db
      .insert(schema.abuseReports)
      .values({
        hash: cleanHash,
        url,
        reason,
        contact,
        reporterId: c.var.principal?.userId ?? null,
      })
      .returning({ id: schema.abuseReports.id })
    return c.json({ ok: true, id: report!.id }, 201)
  })

  app.get('/api/admin/abuse-reports', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const status = (['open', 'blocked', 'dismissed'] as const).find(
      (s) => s === c.req.query('status'),
    )
    const t = schema.abuseReports
    const reports = await c.var.ports.db
      .select()
      .from(t)
      .where(eq(t.status, status ?? 'open'))
      .orderBy(desc(t.createdAt))
      .limit(200)
    return c.json({ reports })
  })

  app.patch('/api/admin/abuse-reports/:id', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const b = (await c.req.json().catch(() => null)) as { status?: unknown } | null
    const status = (['open', 'dismissed'] as const).find((s) => s === b?.status)
    if (!status)
      return jsonError(c, 400, 'status must be "dismissed" or "open" (block through the denylist)')
    const t = schema.abuseReports
    const rows = await c.var.ports.db
      .update(t)
      .set({
        status,
        resolvedBy: status === 'open' ? null : c.var.principal!.userId,
        resolvedAt: status === 'open' ? null : new Date(),
      })
      .where(eq(t.id, c.req.param('id')))
      .returning({ id: t.id })
    if (!rows.length) return jsonError(c, 404, 'Report not found')
    return c.json({ ok: true })
  })

  app.get('/api/admin/denylist', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const entries = await c.var.ports.db
      .select()
      .from(schema.denylist)
      .orderBy(desc(schema.denylist.createdAt))
    return c.json({ entries })
  })

  app.post('/api/admin/denylist', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const hash = str(b?.hash, 80)?.replace(/^sha256:/, '')
    const kind = (['file', 'record'] as const).find((k) => k === b?.kind)
    const reason = str(b?.reason, 4000)?.trim()
    if (!hash || !/^[0-9a-f]{64}$/.test(hash) || !kind || !reason) {
      return jsonError(c, 400, 'hash (64 hex), kind ("file" or "record") and reason are required')
    }
    const { db } = c.var.ports
    const userId = c.var.principal!.userId
    await db
      .insert(schema.denylist)
      .values({ hash, kind, reason })
      .onConflictDoUpdate({ target: schema.denylist.hash, set: { kind, reason } })
    // Every open report on this hash, and the one named, is resolved by the block.
    const reportId = str(b?.reportId, 64)
    const t = schema.abuseReports
    await db
      .update(t)
      .set({ status: 'blocked', resolvedBy: userId, resolvedAt: new Date() })
      .where(
        and(
          eq(t.status, 'open'),
          reportId ? or(eq(t.hash, hash), eq(t.id, reportId)) : eq(t.hash, hash),
        ),
      )
    forgetDenylist(db)
    return c.json({ ok: true }, 201)
  })

  app.delete('/api/admin/denylist/:hash', async (c) => {
    const denied = await stewardOnly(c)
    if (denied) return denied
    const { db } = c.var.ports
    const rows = await db
      .delete(schema.denylist)
      .where(eq(schema.denylist.hash, c.req.param('hash').replace(/^sha256:/, '')))
      .returning({ hash: schema.denylist.hash })
    if (!rows.length) return jsonError(c, 404, 'Not on the denylist')
    forgetDenylist(db)
    return c.json({ ok: true })
  })

  return app
}
