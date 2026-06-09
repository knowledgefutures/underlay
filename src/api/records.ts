import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { streamText } from 'hono/streaming'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { type AuthEnv } from './auth.server.js'

const BatchRequest = z.object({
  hashes: z.array(z.string()).min(1).max(10000),
})

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

      if (!record) return c.json({ error: 'Record not found' }, 404)

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

      const CHUNK = 500
      c.header('Content-Type', 'application/x-ndjson')
      return streamText(c, async (stream) => {
        for (let i = 0; i < hashes.length; i += CHUNK) {
          const chunk = hashes.slice(i, i + CHUNK)
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
    },
  )

export default app
