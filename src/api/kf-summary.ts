import { eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, schema } from '../db/client.server.js'

/**
 * GET /api/kf/summary?kf_org_id=xxx
 *
 * Returns Underlay accounts and their collections linked to a KF org.
 * For user-type accounts it also includes UL orgs the user belongs to.
 *
 * Auth: requires KF_INTERNAL_API_KEY (service-to-service).
 */
export async function summary(c: Context) {
  const kfOrgId = c.req.query('kf_org_id')
  if (!kfOrgId) {
    return c.json({ error: 'kf_org_id is required' }, 400)
  }

  // Verify internal API key
  const authHeader = c.req.header('Authorization')
  const expectedKey = process.env.KF_INTERNAL_API_KEY
  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const APP_URL = process.env.APP_URL ?? 'http://localhost:4100'

  // Find local accounts linked to this KF org via kf_org_id.
  const directAccounts = await db
    .select({
      id: schema.accounts.id,
      slug: schema.accounts.slug,
      type: schema.accounts.type,
      displayName: schema.accounts.displayName,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.kfOrgId, kfOrgId))

  if (directAccounts.length === 0) {
    return c.json({ accounts: [] })
  }

  const allAccountIds = directAccounts.map((a) => a.id)

  // Get collections for all accounts
  const collections = await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      accountId: schema.collections.accountId,
      ownerSlug: schema.accounts.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(
      sql`${schema.collections.accountId} IN (${sql.join(
        allAccountIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )

  // Get version stats if we have collections
  const statsMap = new Map<
    string,
    { versions: number; records: number; files: number; bytes: number }
  >()

  if (collections.length > 0) {
    const versionStats = await db
      .select({
        collectionId: schema.versions.collectionId,
        versionCount: sql<number>`count(*)::int`,
        totalRecords: sql<number>`coalesce(sum(${schema.versions.recordCount}), 0)::int`,
        totalFiles: sql<number>`coalesce(sum(${schema.versions.fileCount}), 0)::int`,
        totalBytes: sql<number>`coalesce(sum(${schema.versions.totalBytes}), 0)::bigint`,
      })
      .from(schema.versions)
      .where(
        sql`${schema.versions.collectionId} IN (${sql.join(
          collections.map((c) => sql`${c.id}`),
          sql`, `,
        )})`,
      )
      .groupBy(schema.versions.collectionId)

    for (const s of versionStats) {
      statsMap.set(s.collectionId, {
        versions: s.versionCount,
        records: s.totalRecords,
        files: s.totalFiles,
        bytes: s.totalBytes,
      })
    }
  }

  // Group collections by account
  const collectionsByAccount = new Map<string, typeof collections>()
  for (const col of collections) {
    const list = collectionsByAccount.get(col.accountId) ?? []
    list.push(col)
    collectionsByAccount.set(col.accountId, list)
  }

  return c.json({
    accounts: directAccounts.map((acct) => ({
      id: acct.id,
      slug: acct.slug,
      type: acct.type,
      name: acct.displayName ?? acct.slug,
      url: `${APP_URL}/${acct.slug}`,
      collections: (collectionsByAccount.get(acct.id) ?? []).map((col) => {
        const stats = statsMap.get(col.id)
        return {
          id: col.id,
          name: col.name,
          slug: col.slug,
          url: `${APP_URL}/${col.ownerSlug}/${col.slug}`,
          stats: stats ?? { versions: 0, records: 0, files: 0, bytes: 0 },
        }
      }),
    })),
  })
}
