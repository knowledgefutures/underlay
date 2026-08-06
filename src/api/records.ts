import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { streamText } from 'hono/streaming'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { filterRecordData, getPrivateFields } from '../lib/core/index.js'
import { type AuthEnv, fullPrincipalUserId } from './auth.server.js'

const BatchRequest = z.object({
  hashes: z.array(z.string()).min(1).max(10000),
})

type RecordAccess = { full: boolean; privateFields: Set<string> }

type PublicHashEntry = { recordHash: string; privateFields: Set<string> }

/**
 * Map requested public record hashes (the content-address of a record's
 * private-field-stripped projection, as listed in public manifests) to their
 * underlying records, along with the private-field set of the schema binding
 * that produced each public hash.
 */
async function resolvePublicHashes(hashes: string[]): Promise<Map<string, PublicHashEntry>> {
  const map = new Map<string, PublicHashEntry>()
  if (hashes.length === 0) return map
  const rows = await db
    .select({
      publicRecordHash: schema.versionRecords.publicRecordHash,
      recordHash: schema.versionRecords.recordHash,
      schemaBody: schema.schemas.schema,
    })
    .from(schema.versionRecords)
    .innerJoin(
      schema.recordObjects,
      eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
    )
    .innerJoin(
      schema.versionSchemas,
      and(
        eq(schema.versionSchemas.versionId, schema.versionRecords.versionId),
        eq(schema.versionSchemas.slug, schema.recordObjects.type),
      ),
    )
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(inArray(schema.versionRecords.publicRecordHash, hashes))
    .groupBy(
      schema.versionRecords.publicRecordHash,
      schema.versionRecords.recordHash,
      schema.schemas.schema,
    )
  for (const row of rows) {
    if (!row.publicRecordHash || map.has(row.publicRecordHash)) continue
    map.set(row.publicRecordHash, {
      recordHash: row.recordHash,
      privateFields: getPrivateFields(row.schemaBody as Record<string, unknown>),
    })
  }
  return map
}

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
      eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
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
    // Record-level privacy is per-version: a hash is publicly readable if it
    // appears NOT-private in some public collection's version (under a
    // non-private type). This is the correct global-lookup OR semantics.
    .where(
      and(
        inArray(schema.versionRecords.recordHash, remaining),
        eq(schema.versionRecords.private, false),
      ),
    )
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

      const lookup = async (h: string) => {
        const [row] = await db
          .select({
            recordId: schema.recordObjects.recordId,
            type: schema.recordObjects.type,
            data: schema.recordObjects.data,
            size: schema.recordObjects.size,
            createdAt: schema.recordObjects.createdAt,
          })
          .from(schema.recordObjects)
          .where(eq(schema.recordObjects.hash, h))
          .limit(1)
        return row
      }

      // The hash may be a full record hash or a public record hash (the
      // address of the private-field-stripped projection)
      let recordHash = hash
      let publicProjection: Set<string> | null = null
      let record = await lookup(hash)
      if (!record) {
        const pub = (await resolvePublicHashes([hash])).get(hash)
        if (pub) {
          recordHash = pub.recordHash
          publicProjection = pub.privateFields
          record = await lookup(pub.recordHash)
        }
      }

      if (!record) return c.json({ error: 'Record not found', statusCode: 404 }, 404)

      const accessEntry = (await resolveRecordAccess([recordHash], fullPrincipalUserId(c))).get(
        recordHash,
      )
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
        .where(
          and(
            eq(schema.versionRecords.recordHash, recordHash),
            eq(schema.collections.public, true),
          ),
        )
        .orderBy(sql`${schema.versions.createdAt} asc`)

      const firstSeen = references.length > 0 ? references[0]!.versionCreatedAt : record.createdAt

      // When addressed by public hash, always serve the matching projection
      const data = publicProjection
        ? filterRecordData(record.data, publicProjection)
        : !accessEntry.full && accessEntry.privateFields.size > 0
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
      // A collection-scoped key is treated anonymously for global hash lookups.
      const userId = fullPrincipalUserId(c)

      const CHUNK = 500
      c.header('Content-Type', 'application/x-ndjson')
      return streamText(c, async (stream) => {
        for (let i = 0; i < hashes.length; i += CHUNK) {
          const chunk = hashes.slice(i, i + CHUNK)

          // Requested hashes may be full record hashes or public record hashes
          const publicMap = await resolvePublicHashes(chunk)
          const lookupHashes = [
            ...new Set([...chunk, ...[...publicMap.values()].map((e) => e.recordHash)]),
          ]
          const access = await resolveRecordAccess(lookupHashes, userId)
          const readable = lookupHashes.filter((h) => access.has(h))
          if (readable.length === 0) continue

          const rows = await db
            .select({
              hash: schema.recordObjects.hash,
              recordId: schema.recordObjects.recordId,
              type: schema.recordObjects.type,
              data: schema.recordObjects.data,
            })
            .from(schema.recordObjects)
            .where(inArray(schema.recordObjects.hash, readable))
          const rowByHash = new Map(rows.map((r) => [r.hash, r]))

          for (const requested of chunk) {
            const direct = rowByHash.get(requested)
            if (direct && access.has(requested)) {
              const accessEntry = access.get(requested)!
              const data =
                !accessEntry.full && accessEntry.privateFields.size > 0
                  ? filterRecordData(direct.data, accessEntry.privateFields)
                  : direct.data
              await stream.write(
                JSON.stringify({
                  id: direct.recordId,
                  type: direct.type,
                  data,
                  hash: direct.hash,
                }) + '\n',
              )
              continue
            }

            // Public-address request: always serve the projection that hashes
            // to the requested address, regardless of the caller's access level
            const pub = publicMap.get(requested)
            if (!pub || !access.has(pub.recordHash)) continue
            const row = rowByHash.get(pub.recordHash)
            if (!row) continue
            await stream.write(
              JSON.stringify({
                id: row.recordId,
                type: row.type,
                data: filterRecordData(row.data, pub.privateFields),
                hash: requested,
              }) + '\n',
            )
          }
        }
      })
    },
  )

export default app
