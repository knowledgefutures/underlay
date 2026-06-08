import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { streamText } from 'hono/streaming'

import { db, schema } from '../db/client.server.js'
import { type AuthEnv } from './auth.server.js'

// GET /api/records/:hash/provenance — Find all versions/collections referencing a record
export async function provenance(c: Context<AuthEnv>) {
  const hash = c.req.param('hash')!

  const [record] = await db
    .select({
      recordId: schema.recordObjects.recordId,
      type: schema.recordObjects.type,
      data: schema.recordObjects.data,
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
    data: record.data,
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

// POST /api/records/batch — Fetch record objects by hash, returns JSONL
export async function batch(c: Context<AuthEnv>) {
  const body = (await c.req.json()) as { hashes: string[] }

  if (!body.hashes?.length) {
    return c.json({ error: 'hashes array is required' }, 400)
  }

  if (body.hashes.length > 10000) {
    return c.json({ error: 'Maximum 10,000 hashes per request' }, 400)
  }

  const CHUNK = 500
  c.header('Content-Type', 'application/x-ndjson')
  return streamText(c, async (stream) => {
    for (let i = 0; i < body.hashes.length; i += CHUNK) {
      const chunk = body.hashes.slice(i, i + CHUNK)
      const rows = await db
        .select({
          hash: schema.recordObjects.hash,
          recordId: schema.recordObjects.recordId,
          type: schema.recordObjects.type,
          data: schema.recordObjects.data,
          private: schema.recordObjects.private,
        })
        .from(schema.recordObjects)
        .where(inArray(schema.recordObjects.hash, chunk))

      for (const row of rows) {
        await stream.write(
          JSON.stringify({
            id: row.recordId,
            type: row.type,
            data: row.data,
            private: row.private,
            hash: row.hash,
          }) + '\n',
        )
      }
    }
  })
}
