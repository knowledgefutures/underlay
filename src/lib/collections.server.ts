import { and, eq, sql } from 'drizzle-orm'

import { db, schema } from '~/db/client.server'
import { buildArkUrl, DEFAULT_NAAN } from '~/lib/ark'

export async function getCollectionPageData(owner: string, slug: string, userId?: string) {
  const [result] = await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      description: schema.collections.description,
      public: schema.collections.public,
      ownerSlug: schema.organization.slug,
      ownerName: schema.organization.name,
      createdAt: schema.collections.createdAt,
      updatedAt: schema.collections.updatedAt,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)

  if (!result) return null

  if (!result.public) {
    const [org] = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, owner))
      .limit(1)

    if (!org) return null

    let hasAccess = false
    if (userId) {
      const [membership] = await db
        .select()
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, userId)))
        .limit(1)
      hasAccess = !!membership
    }
    if (!hasAccess) return null
  }

  const [latestVersion] = await db
    .select({
      id: schema.versions.id,
      number: schema.versions.number,
      semver: schema.versions.semver,
      recordCount: schema.versions.recordCount,
      fileCount: schema.versions.fileCount,
      totalBytes: schema.versions.totalBytes,
      createdAt: schema.versions.createdAt,
      message: schema.versions.message,
      readme: schema.versions.readme,
    })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, result.id))
    .orderBy(sql`${schema.versions.number} desc`)
    .limit(1)

  let typeCounts: { type: string; count: number }[] = []
  if (latestVersion) {
    const rows = await db
      .select({
        type: schema.records.type,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.records)
      .where(eq(schema.records.versionId, latestVersion.id))
      .groupBy(schema.records.type)
    typeCounts = rows.map((r) => ({ type: r.type, count: r.count }))
  }

  let ark: string | null = null
  try {
    const [arkRow] = await db
      .select({
        arkId: schema.arkCollections.arkId,
        enabled: schema.arkCollections.enabled,
        shoulder: schema.arkShoulders.shoulder,
        ownerNaan: schema.organization.arkNaan,
      })
      .from(schema.arkCollections)
      .innerJoin(schema.collections, eq(schema.arkCollections.collectionId, schema.collections.id))
      .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
      .innerJoin(
        schema.arkShoulders,
        eq(schema.arkShoulders.organizationId, schema.organization.id),
      )
      .where(eq(schema.arkCollections.collectionId, result.id))
      .limit(1)
    if (arkRow?.enabled) {
      ark = buildArkUrl(arkRow.ownerNaan ?? DEFAULT_NAAN, arkRow.shoulder, arkRow.arkId)
    }
  } catch {
    // Non-fatal
  }

  const { id: _id, ...collectionData } = result
  const { id: _vid, ...latestVersionData } = latestVersion ?? { id: undefined }
  return {
    ...collectionData,
    ark,
    latestVersion: latestVersion ? { ...latestVersionData, typeCounts } : null,
  }
}
