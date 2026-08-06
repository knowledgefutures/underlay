import crypto from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, schema } from '../db/client.server.js'

function timingSafeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * GET /api/kf/summary?kf_org_id=xxx
 *
 * Returns Underlay orgs and their collections linked to a KF org.
 *
 * Auth: requires AUTH_INTERNAL_API_KEY (service-to-service).
 */
export async function summary(c: Context) {
  const kfOrgId = c.req.query('kf_org_id')
  if (!kfOrgId) {
    return c.json({ error: 'kf_org_id is required', statusCode: 400 }, 400)
  }

  // Verify internal API key
  const authHeader = c.req.header('Authorization')
  const expectedKey = process.env.AUTH_INTERNAL_API_KEY
  if (!expectedKey || !authHeader || !timingSafeEquals(authHeader, `Bearer ${expectedKey}`)) {
    return c.json({ error: 'Unauthorized', statusCode: 401 }, 401)
  }

  const APP_URL = process.env.APP_URL ?? 'http://localhost:4100'

  // Find local orgs linked to this KF org via kf_org_id.
  const directOrgs = await db
    .select({
      id: schema.organization.id,
      slug: schema.organization.slug,
      displayName: schema.organization.name,
    })
    .from(schema.organization)
    .where(eq(schema.organization.kfOrgId, kfOrgId))

  if (directOrgs.length === 0) {
    return c.json({ orgs: [] })
  }

  const allOrgIds = directOrgs.map((a) => a.id)

  // Get collections for all orgs
  const collections = await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      organizationId: schema.collections.organizationId,
      ownerSlug: schema.organization.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(
      sql`${schema.collections.organizationId} IN (${sql.join(
        allOrgIds.map((id) => sql`${id}`),
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
        and(
          sql`${schema.versions.collectionId} IN (${sql.join(
            collections.map((c) => sql`${c.id}`),
            sql`, `,
          )})`,
          eq(schema.versions.status, 'ready'),
        ),
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

  // Group collections by org
  const collectionsByOrg = new Map<string, typeof collections>()
  for (const col of collections) {
    const list = collectionsByOrg.get(col.organizationId) ?? []
    list.push(col)
    collectionsByOrg.set(col.organizationId, list)
  }

  return c.json({
    orgs: directOrgs.map((org) => ({
      id: org.id,
      slug: org.slug,
      name: org.displayName ?? org.slug,
      url: `${APP_URL}/${org.slug}`,
      collections: (collectionsByOrg.get(org.id) ?? []).map((col) => {
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
