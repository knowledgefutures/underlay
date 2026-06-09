import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { streamText } from 'hono/streaming'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { filterRecordData, getPrivateFields } from '../lib/core/index.js'
import { type AuthEnv } from './auth.server.js'

const BatchRequest = z.object({
  hashes: z.array(z.string()).min(1).max(10000),
})

type RecordAccess = { full: boolean; privateFields: Set<string> }

/**
 * Determine which record objects the caller may read, and at what level.
 * - Full access: the record appears in a collection owned by an org the caller belongs to.
 * - Public access: the record appears in a public collection under a non-private type
 *   schema and is not flagged private; private fields (per the least-restrictive public
 *   schema binding) must be stripped.
 * Hashes absent from the returned map are not readable by the caller.
 */
async function resolveRecordAccess(
  hashes: string[],
  userId: string | undefined,
): Promise<Map<string, RecordAccess>> {
  const access = new Map<string, RecordAccess>()
  if (hashes.length === 0) return access

  if (userId) {
    const memberRows = await db
      .select({ hash: schema.versionRecords.recordHash })
      .from(schema.versionRecords)
      .innerJoin(schema.versions, eq(schema.versionRecords.versionId, schema.versions.id))
      .innerJoin(schema.collections, eq(schema.versions.collectionId, schema.collections.id))
      .innerJoin(
        schema.member,
        and(
          eq(schema.member.organizationId, schema.collections.organizationId),
          eq(schema.member.userId, userId),
        ),
      )
      .where(inArray(schema.versionRecords.recordHash, hashes))
      .groupBy(schema.versionRecords.recordHash)
    for (const r of memberRows) access.set(r.hash, { full: true, privateFields: new Set() })
  }

  const remaining = hashes.filter((h) => !access.has(h))
  if (remaining.length === 0) return access

  const publicRows = await db
    .select({
      hash: schema.versionRecords.recordHash,
      schemaBody: schema.schemas.schema,
    })
    .from(schema.versionRecords)
    .innerJoin(
      schema.recordObjects,
      and(
        eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
        eq(schema.recordObjects.private, false),
      ),
    )
    .innerJoin(schema.versions, eq(schema.versionRecords.versionId, schema.versions.id))
    .innerJoin(
      schema.collections,
      and(
        eq(schema.versions.collectionId, schema.collections.id),
        eq(schema.collections.public, true),
      ),
    )
    .innerJoin(
      schema.versionSchemas,
      and(
        eq(schema.versionSchemas.versionId, schema.versions.id),
        eq(schema.versionSchemas.slug, schema.recordObjects.type),
      ),
    )
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(inArray(schema.versionRecords.recordHash, remaining))
    .groupBy(schema.versionRecords.recordHash, schema.schemas.schema)

  for (const row of publicRows) {
    if ((row.schemaBody as { private?: boolean } | null)?.private === true) continue
    const fields = getPrivateFields(row.schemaBody as Record<string, unknown>)
    const existing = access.get(row.hash)
    if (!existing) {
      access.set(row.hash, { full: false, privateFields: fields })
    } else if (!existing.full && fields.size < existing.privateFields.size) {
      // A record published under multiple public schemas is as visible as its
      // least-restrictive binding
      existing.privateFields = fields
    }
  }
  return access
}

const app = new Hono<AuthEnv>()
  .get(
    '/:hash/provenance',
    openApi({
      tags: ['Records'],
      summary: 'Get provenance for a record by hash',
      request: { param: z.object({ hash: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { hash } = c.req.valid('param')

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

      if (!record) return c.json({ error: 'Record not found', statusCode: 404 }, 404)

      const accessEntry = (await resolveRecordAccess([hash], c.get('userId'))).get(hash)
      if (!accessEntry) return c.json({ error: 'Record not found', statusCode: 404 }, 404)

      const references = await db
        .select({
          ownerSlug: schema.organization.slug,
          collectionSlug: schema.collections.slug,
          collectionName: schema.collections.name,
          versionSemver: schema.versions.semver,
          versionCreatedAt: schema.versions.createdAt,
        })
        .from(schema.versionRecords)
        .innerJoin(schema.versions, eq(schema.versionRecords.versionId, schema.versions.id))
        .innerJoin(schema.collections, eq(schema.versions.collectionId, schema.collections.id))
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(and(eq(schema.versionRecords.recordHash, hash), eq(schema.collections.public, true)))
        .orderBy(sql`${schema.versions.createdAt} asc`)

      const firstSeen = references.length > 0 ? references[0]!.versionCreatedAt : record.createdAt

      const data =
        !accessEntry.full && accessEntry.privateFields.size > 0
          ? filterRecordData(record.data, accessEntry.privateFields)
          : record.data

      return c.json({
        hash,
        recordId: record.recordId,
        type: record.type,
        data,
        size: record.size,
        createdAt: record.createdAt,
        firstSeen,
        references: references.map((r) => ({
          owner: r.ownerSlug,
          collection: r.collectionSlug,
          collectionName: r.collectionName,
          semver: r.versionSemver,
          versionCreatedAt: r.versionCreatedAt,
        })),
      })
    },
  )
  .post(
    '/batch',
    openApi({
      tags: ['Records'],
      summary: 'Fetch record objects by hash (JSONL stream)',
      request: { json: BatchRequest },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { hashes } = c.req.valid('json')
      const userId = c.get('userId')

      const CHUNK = 500
      c.header('Content-Type', 'application/x-ndjson')
      return streamText(c, async (stream) => {
        for (let i = 0; i < hashes.length; i += CHUNK) {
          const chunk = hashes.slice(i, i + CHUNK)
          const access = await resolveRecordAccess(chunk, userId)
          const readable = chunk.filter((h) => access.has(h))
          if (readable.length === 0) continue

          const rows = await db
            .select({
              hash: schema.recordObjects.hash,
              recordId: schema.recordObjects.recordId,
              type: schema.recordObjects.type,
              data: schema.recordObjects.data,
              private: schema.recordObjects.private,
            })
            .from(schema.recordObjects)
            .where(inArray(schema.recordObjects.hash, readable))

          for (const row of rows) {
            const accessEntry = access.get(row.hash)!
            const data =
              !accessEntry.full && accessEntry.privateFields.size > 0
                ? filterRecordData(row.data, accessEntry.privateFields)
                : row.data
            await stream.write(
              JSON.stringify({
                id: row.recordId,
                type: row.type,
                data,
                private: row.private,
                hash: row.hash,
              }) + '\n',
            )
          }
        }
      })
    },
  )

export default app
