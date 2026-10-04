/**
 * Instance metrics for the steward admin pages. Stewards only.
 *
 *   GET /api/admin/stats/overview?days=     totals, the period's usage by day, what needs attention
 *   GET /api/admin/stats/orgs?days=         per organization: size, history, usage in the period
 *   GET /api/admin/stats/orgs/:slug?days=   one organization: per collection, and usage by day
 *   GET /api/admin/stats/corpus             types, shared schemas, largest collections, growth
 *   GET /api/admin/stats/billing?month=     metered quantities per organization for a month,
 *                                           reconcile health and deletions
 *   GET /api/admin/stats/operations         push sessions, storage locations, uploads, jobs
 *
 * Sizes are logical: a version's `total_bytes` is its records and files as the
 * root counts them, so history bytes count shared content once per version
 * (edge-redesign.md, "Metering": bill on deterministic logical measures). The
 * physical store is the `files` table's unique bytes plus the repositories.
 * `days` is 1–365 (default 30), counted in UTC days ending today.
 */
import { type SQL, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import type { UsageMetric } from '../billing/usage.js'
import { jsonError } from './access.js'
import { stewardOnly } from './admin.js'

const METRICS: UsageMetric[] = ['api_calls', 'response_bytes', 'file_downloads', 'file_bytes']
type Usage = Record<UsageMetric, number>

const emptyUsage = (): Usage => ({
  api_calls: 0,
  response_bytes: 0,
  file_downloads: 0,
  file_bytes: 0,
})

const n = (v: unknown) => Number(v ?? 0)
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)
const DAY_MS = 86_400_000

/** The period's first day and every day in it (UTC, oldest first). */
function period(c: Context<AppEnv>): { since: string; days: string[] } {
  const raw = Number(c.req.query('days') ?? 30)
  const count = Number.isInteger(raw) ? Math.min(365, Math.max(1, raw)) : 30
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  )
  const days = Array.from({ length: count }, (_, i) => isoDay(today - (count - 1 - i) * DAY_MS))
  return { since: days[0]!, days }
}

async function rows<T>(c: Context<AppEnv>, query: SQL): Promise<T[]> {
  return (await c.var.ports.db.all(query)) as T[]
}

/** Usage summed by `key` (a column of usage_rollups) over days matching `where`. */
async function usageBy(
  c: Context<AppEnv>,
  key: 'account_id' | 'collection_id' | 'day',
  where: SQL,
): Promise<Map<string, Usage>> {
  const out = new Map<string, Usage>()
  const found = await rows<{ k: string; metric: UsageMetric; amount: number }>(
    c,
    sql`SELECT ${sql.raw(key)} AS k, metric, sum(amount) AS amount
        FROM usage_rollups WHERE ${where} GROUP BY ${sql.raw(key)}, metric`,
  )
  for (const r of found) {
    if (!METRICS.includes(r.metric)) continue
    const u = out.get(r.k) ?? emptyUsage()
    u[r.metric] += n(r.amount)
    out.set(r.k, u)
  }
  return out
}

/** Per live collection: its owner, head version figures, and history totals. */
interface CollectionFigures {
  id: string
  slug: string
  name: string
  orgId: string
  public: boolean
  records: number
  publicRecords: number
  files: number
  latestBytes: number
  versions: number
  historyBytes: number
  refEvents: number
  refBytes: number
  lastPushAt: number | null
  reconciledAt: number | null
  corrections: number
}

async function collectionFigures(c: Context<AppEnv>, orgId?: string) {
  const found = await rows<Record<string, unknown>>(
    c,
    sql`SELECT c.id, c.slug, c.name, c.organization_id AS orgId, c.public,
          coalesce(v.record_count, 0) AS records,
          coalesce(v.public_record_count, 0) AS publicRecords,
          coalesce(v.file_count, 0) AS files,
          coalesce(v.total_bytes, 0) AS latestBytes,
          c.version_count AS versions,
          c.history_bytes AS historyBytes,
          c.ref_events AS refEvents, c.ref_bytes AS refBytes,
          c.last_push_at AS lastPushAt, c.reconciled_at AS reconciledAt,
          coalesce(json_array_length(c.reconcile_report), 0) AS corrections
        FROM collections c
        LEFT JOIN versions v ON v.id = c.head_version_id
        WHERE c.deleted_at IS NULL ${orgId ? sql`AND c.organization_id = ${orgId}` : sql``}`,
  )
  return found.map((r): CollectionFigures => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    orgId: String(r.orgId),
    public: !!r.public,
    records: n(r.records),
    publicRecords: n(r.publicRecords),
    files: n(r.files),
    latestBytes: n(r.latestBytes),
    versions: n(r.versions),
    historyBytes: n(r.historyBytes),
    refEvents: n(r.refEvents),
    refBytes: n(r.refBytes),
    lastPushAt: r.lastPushAt == null ? null : n(r.lastPushAt),
    reconciledAt: r.reconciledAt == null ? null : n(r.reconciledAt),
    corrections: n(r.corrections),
  }))
}

const SUMMED = [
  'records',
  'publicRecords',
  'files',
  'latestBytes',
  'versions',
  'historyBytes',
  'refEvents',
  'refBytes',
] as const
type Sums = Record<(typeof SUMMED)[number], number>

function sums(cols: CollectionFigures[]): Sums {
  const out = Object.fromEntries(SUMMED.map((k) => [k, 0])) as Sums
  for (const col of cols) for (const k of SUMMED) out[k] += col[k]
  return out
}

/** The organizations, with members and their collections' figures summed; and the collections. */
async function orgFigures(c: Context<AppEnv>) {
  const [orgs, members, cols] = await Promise.all([
    rows<{ id: string; slug: string; name: string; isDefault: number; createdAt: number }>(
      c,
      sql`SELECT id, slug, name, is_default AS isDefault, created_at AS createdAt FROM organization`,
    ),
    rows<{ orgId: string; n: number }>(
      c,
      sql`SELECT organization_id AS orgId, count(*) AS n FROM member GROUP BY organization_id`,
    ),
    collectionFigures(c),
  ])
  const memberCount = new Map(members.map((m) => [m.orgId, n(m.n)]))
  const byOrg = new Map<string, CollectionFigures[]>()
  for (const col of cols) byOrg.set(col.orgId, [...(byOrg.get(col.orgId) ?? []), col])
  const perOrg = orgs.map((o) => {
    const mine = byOrg.get(o.id) ?? []
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      personal: !!o.isDefault,
      createdAt: n(o.createdAt),
      members: memberCount.get(o.id) ?? 0,
      collections: mine.length,
      publicCollections: mine.filter((col) => col.public).length,
      lastPushAt: mine.reduce<number | null>(
        (m, col) =>
          col.lastPushAt != null && (m == null || col.lastPushAt > m) ? col.lastPushAt : m,
        null,
      ),
      ...sums(mine),
    }
  })
  return { orgs: perOrg, cols }
}

export function statsRoutes() {
  const app = new Hono<AppEnv>()

  app.use('/api/admin/stats/*', async (c, next) => {
    const denied = await stewardOnly(c)
    return denied ?? next()
  })

  app.get('/api/admin/stats/overview', async (c) => {
    const { since, days } = period(c)
    const dayAgo = Date.now() - DAY_MS
    const [{ orgs, cols }, users, files, schemas, daily, attention] = await Promise.all([
      orgFigures(c),
      rows<{ n: number }>(c, sql`SELECT count(*) AS n FROM user`),
      rows<{ n: number; bytes: number }>(
        c,
        sql`SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files`,
      ),
      rows<{ n: number }>(c, sql`SELECT count(*) AS n FROM schemas`),
      usageBy(c, 'day', sql`day >= ${since}`),
      rows<Record<string, number>>(
        c,
        sql`SELECT
          (SELECT count(*) FROM abuse_reports WHERE status = 'open') AS openReports,
          (SELECT count(*) FROM collections WHERE deleted_at IS NULL
             AND json_array_length(reconcile_report) > 0) AS corrections,
          (SELECT count(*) FROM storage_locations
             WHERE kind != 'platform' AND status IN ('broken', 'unverified')) AS locationProblems,
          (SELECT count(*) FROM push_sessions
             WHERE status = 'failed' AND created_at >= ${dayAgo}) AS failedPushes,
          (SELECT count(*) FROM push_sessions WHERE status IN ('open', 'committing')) AS openPushes`,
      ),
    ])
    const usage = emptyUsage()
    for (const u of daily.values()) for (const m of METRICS) usage[m] += u[m]
    return c.json({
      since,
      totals: {
        users: n(users[0]?.n),
        orgs: orgs.filter((o) => !o.personal).length,
        personalOrgs: orgs.filter((o) => o.personal).length,
        collections: cols.length,
        publicCollections: cols.filter((col) => col.public).length,
        ...sums(cols),
        uniqueFiles: n(files[0]?.n),
        uniqueFileBytes: n(files[0]?.bytes),
        schemas: n(schemas[0]?.n),
      },
      usage,
      daily: days.map((day) => ({ day, ...(daily.get(day) ?? emptyUsage()) })),
      attention: Object.fromEntries(Object.entries(attention[0] ?? {}).map(([k, v]) => [k, n(v)])),
    })
  })

  app.get('/api/admin/stats/orgs', async (c) => {
    const { since } = period(c)
    const [{ orgs }, usage] = await Promise.all([
      orgFigures(c),
      usageBy(c, 'account_id', sql`day >= ${since}`),
    ])
    return c.json({
      since,
      orgs: orgs.map((o) => ({ ...o, usage: usage.get(o.id) ?? emptyUsage() })),
    })
  })

  app.get('/api/admin/stats/orgs/:slug', async (c) => {
    const { since, days } = period(c)
    const [org] = await rows<{ id: string; slug: string; name: string; isDefault: number }>(
      c,
      sql`SELECT id, slug, name, is_default AS isDefault FROM organization
          WHERE slug = ${c.req.param('slug')}`,
    )
    if (!org) return jsonError(c, 404, 'Organization not found')
    const scope = sql`account_id = ${org.id} AND day >= ${since}`
    const [cols, byCollection, daily, members] = await Promise.all([
      collectionFigures(c, org.id),
      usageBy(c, 'collection_id', scope),
      usageBy(c, 'day', scope),
      rows<{ name: string; email: string; role: string }>(
        c,
        sql`SELECT u.name, u.email, m.role FROM member m
            JOIN user u ON u.id = m.user_id WHERE m.organization_id = ${org.id}
            ORDER BY u.name`,
      ),
    ])
    const usage = emptyUsage()
    for (const u of daily.values()) for (const m of METRICS) usage[m] += u[m]
    return c.json({
      since,
      org: { id: org.id, slug: org.slug, name: org.name, personal: !!org.isDefault },
      totals: sums(cols),
      usage,
      daily: days.map((day) => ({ day, ...(daily.get(day) ?? emptyUsage()) })),
      members,
      collections: cols.map((col) => ({ ...col, usage: byCollection.get(col.id) ?? emptyUsage() })),
    })
  })

  app.get('/api/admin/stats/corpus', async (c) => {
    const [heads, shared, growth, cols] = await Promise.all([
      rows<{ typeCounts: string | null; publicTypeCounts: string | null }>(
        c,
        sql`SELECT v.type_counts AS typeCounts, v.public_type_counts AS publicTypeCounts
            FROM collections c JOIN versions v ON v.id = c.head_version_id
            WHERE c.deleted_at IS NULL`,
      ),
      rows<{ hash: string; type: string; collections: number }>(
        c,
        sql`SELECT su.schema_hash AS hash, min(su.type_slug) AS type,
              count(DISTINCT su.collection_id) AS collections
            FROM schema_usage su JOIN collections c ON c.id = su.collection_id
            WHERE su.to_seq IS NULL AND c.deleted_at IS NULL
            GROUP BY su.schema_hash ORDER BY collections DESC, type LIMIT 20`,
      ),
      rows<{ month: string; versions: number; added: number; removed: number; updated: number }>(
        c,
        sql`SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month,
              count(*) AS versions,
              coalesce(sum(json_extract(changes, '$.added')), 0) AS added,
              coalesce(sum(json_extract(changes, '$.removed')), 0) AS removed,
              coalesce(sum(json_extract(changes, '$.updated')), 0) AS updated
            FROM versions GROUP BY month ORDER BY month`,
      ),
      collectionFigures(c),
    ])
    const types = new Map<string, { records: number; publicRecords: number; collections: number }>()
    for (const h of heads) {
      const all = JSON.parse(h.typeCounts ?? '{}') as Record<string, number>
      const pub = JSON.parse(h.publicTypeCounts ?? '{}') as Record<string, number>
      for (const [type, count] of Object.entries(all)) {
        const t = types.get(type) ?? { records: 0, publicRecords: 0, collections: 0 }
        t.records += n(count)
        t.publicRecords += n(pub[type])
        t.collections++
        types.set(type, t)
      }
    }
    const orgSlugs = new Map(
      (await rows<{ id: string; slug: string }>(c, sql`SELECT id, slug FROM organization`)).map(
        (o) => [o.id, o.slug],
      ),
    )
    const totals = sums(cols)
    return c.json({
      totals: { ...totals, collections: cols.length, types: types.size },
      types: [...types]
        .map(([type, t]) => ({ type, ...t }))
        .sort((a, b) => b.records - a.records)
        .slice(0, 50),
      sharedSchemas: shared.map((s) => ({ ...s, collections: n(s.collections) })),
      largest: [...cols]
        .sort((a, b) => b.records - a.records)
        .slice(0, 15)
        .map((col) => ({
          owner: orgSlugs.get(col.orgId) ?? '?',
          slug: col.slug,
          public: col.public,
          records: col.records,
          latestBytes: col.latestBytes,
          versions: col.versions,
        })),
      growth: growth.map((g) => ({
        month: g.month,
        versions: n(g.versions),
        added: n(g.added),
        removed: n(g.removed),
        updated: n(g.updated),
      })),
    })
  })

  app.get('/api/admin/stats/billing', async (c) => {
    const month = c.req.query('month') ?? new Date().toISOString().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) return jsonError(c, 400, 'month must be YYYY-MM')
    const start = Date.parse(`${month}-01T00:00:00Z`)
    const end = new Date(start)
    end.setUTCMonth(end.getUTCMonth() + 1)
    const [{ orgs, cols }, usage, tombstones, reconcile] = await Promise.all([
      orgFigures(c),
      // A range, not LIKE: it can use the rollups' day index.
      usageBy(c, 'account_id', sql`day >= ${`${month}-01`} AND day < ${isoDay(end.getTime())}`),
      rows<Record<string, unknown>>(
        c,
        sql`SELECT t.slug, o.slug AS owner, t.versions, t.total_bytes AS totalBytes,
              t.ref_events AS refEvents, t.deleted_at AS deletedAt
            FROM collection_tombstones t LEFT JOIN organization o ON o.id = t.organization_id
            WHERE t.deleted_at >= ${start} AND t.deleted_at < ${end.getTime()}
            ORDER BY t.deleted_at DESC`,
      ),
      rows<{ running: number; never: number; stale: number }>(
        c,
        sql`SELECT
              coalesce(sum(reconcile_started_at IS NOT NULL
                AND (reconciled_at IS NULL OR reconciled_at < reconcile_started_at)), 0) AS running,
              coalesce(sum(reconciled_at IS NULL), 0) AS never,
              coalesce(sum(reconciled_at < ${Date.now() - 8 * DAY_MS}), 0) AS stale
            FROM collections WHERE deleted_at IS NULL`,
      ),
    ])
    const orgSlug = new Map(orgs.map((o) => [o.id, o.slug]))
    return c.json({
      month,
      orgs: orgs
        .map((o) => ({
          slug: o.slug,
          name: o.name,
          personal: o.personal,
          collections: o.collections,
          latestBytes: o.latestBytes,
          historyBytes: o.historyBytes,
          refEvents: o.refEvents,
          refBytes: o.refBytes,
          usage: usage.get(o.id) ?? emptyUsage(),
        }))
        .filter((o) => o.collections > 0 || METRICS.some((m) => o.usage[m] > 0) || o.refEvents > 0),
      reconcile: {
        collections: cols.length,
        running: n(reconcile[0]?.running),
        never: n(reconcile[0]?.never),
        stale: n(reconcile[0]?.stale),
        corrected: cols
          .filter((col) => col.corrections > 0)
          .map((col) => ({
            owner: orgSlug.get(col.orgId) ?? '?',
            slug: col.slug,
            corrections: col.corrections,
            reconciledAt: col.reconciledAt,
          })),
      },
      deleted: tombstones.map((t) => ({
        owner: t.owner ?? null,
        slug: String(t.slug),
        versions: n(t.versions),
        totalBytes: n(t.totalBytes),
        refEvents: n(t.refEvents),
        deletedAt: n(t.deletedAt),
      })),
    })
  })

  app.get('/api/admin/stats/operations', async (c) => {
    const weekAgo = Date.now() - 7 * DAY_MS
    const [sessions, failed, locations, uploads, jobs] = await Promise.all([
      rows<{ status: string; n: number }>(
        c,
        sql`SELECT status, count(*) AS n FROM push_sessions
            WHERE status IN ('open', 'committing') OR created_at >= ${weekAgo}
            GROUP BY status`,
      ),
      rows<Record<string, unknown>>(
        c,
        sql`SELECT s.id, o.slug AS owner, c.slug, s.error, s.created_at AS createdAt
            FROM push_sessions s JOIN collections c ON c.id = s.collection_id
            JOIN organization o ON o.id = c.organization_id
            WHERE s.status = 'failed' AND s.created_at >= ${weekAgo}
            ORDER BY s.created_at DESC LIMIT 20`,
      ),
      rows<Record<string, unknown>>(
        c,
        sql`SELECT l.id, l.name, l.bucket, l.status, l.last_error AS lastError,
              l.checked_at AS checkedAt, o.slug AS owner
            FROM storage_locations l LEFT JOIN organization o ON o.id = l.organization_id
            WHERE l.kind != 'platform' ORDER BY l.status, l.name`,
      ),
      rows<{ status: string; n: number }>(
        c,
        sql`SELECT status, count(*) AS n FROM file_uploads
            WHERE created_at >= ${weekAgo} GROUP BY status`,
      ),
      rows<{ type: string; status: string; n: number }>(
        c,
        sql`SELECT type, status, count(*) AS n FROM jobs
            WHERE status != 'done' GROUP BY type, status ORDER BY type`,
      ),
    ])
    const parseError = (v: unknown) => {
      if (typeof v !== 'string') return null
      try {
        return (JSON.parse(v) as { error?: string }).error ?? v
      } catch {
        return v
      }
    }
    return c.json({
      sessions: sessions.map((s) => ({ ...s, n: n(s.n) })),
      failedPushes: failed.map((f) => ({
        id: String(f.id),
        owner: String(f.owner),
        slug: String(f.slug),
        error: parseError(f.error),
        createdAt: n(f.createdAt),
      })),
      locations: locations.map((l) => ({
        id: String(l.id),
        name: String(l.name),
        bucket: l.bucket ?? null,
        owner: l.owner ?? null,
        status: String(l.status),
        lastError: l.lastError ?? null,
        checkedAt: l.checkedAt == null ? null : n(l.checkedAt),
      })),
      uploads: Object.fromEntries(uploads.map((u) => [u.status, n(u.n)])),
      // The Node runner's table; on Workers jobs go through Queues and don't appear here.
      jobs: jobs.map((j) => ({ ...j, n: n(j.n) })),
    })
  })

  return app
}
