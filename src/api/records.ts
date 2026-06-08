import { and, eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, schema } from '../db/client.server.js'
import { type AuthEnv } from './auth.server.js'

// GET /api/records/:hash/provenance — Find all versions/collections referencing a record
export async function provenance(c: Context<AuthEnv>) {
  const hash = c.req.param('hash')!

  const [record] = await db
    .select({
      recordId: schema.recordObjects.recordId,
      type: schema.recordObjects.type,
      size: schema.recordObjects.size,
      createdAt: schema.recordObjects.createdAt,
    })
    .from(schema.recordObjects)
    .where(eq(schema.recordObjects.hash, hash))
    .limit(1)

  if (!record) return c.json({ error: 'Record not found' }, 404)

  const references = await db
    .select({
      ownerSlug: schema.organization.slug,
      collectionSlug: schema.collections.slug,
      collectionName: schema.collections.name,
      versionNumber: schema.versions.number,
      versionSemver: schema.versions.semver,
      versionCreatedAt: schema.versions.createdAt,
    })
    .from(schema.versionRecords)
    .innerJoin(schema.versions, eq(schema.versionRecords.versionId, schema.versions.id))
    .innerJoin(schema.collections, eq(schema.versions.collectionId, schema.collections.id))
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.versionRecords.recordHash, hash), eq(schema.collections.public, true)))
    .orderBy(sql`${schema.versions.createdAt} asc`)

  const firstSeen = references.length > 0 ? references[0]!.versionCreatedAt : record.createdAt

  return c.json({
    hash,
    recordId: record.recordId,
    type: record.type,
    size: record.size,
    createdAt: record.createdAt,
    firstSeen,
    references: references.map((r) => ({
      owner: r.ownerSlug,
      collection: r.collectionSlug,
      collectionName: r.collectionName,
      version: r.versionNumber,
      semver: r.versionSemver,
      versionCreatedAt: r.versionCreatedAt,
    })),
  })
}
