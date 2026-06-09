import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { buildArkUrl, DEFAULT_NAAN } from '../lib/ark.js'
import {
  canonicalize,
  computePublicHash,
  computeVersionHash,
  deriveSemver,
  filterRecordData,
  filterSchemasForPublic,
  getPrivateFields,
  getPrivateTypes,
  hasOrgAccess,
  loadVersionSchemas,
  parseSemver,
  resolveCollection,
  type SchemaEntry,
} from '../lib/version-helpers.server.js'
import { type AuthEnv, requireAuth } from './auth.server.js'

const app = new Hono<AuthEnv>()
  // List versions
  .get(
    '/:owner/:slug/versions',
    openApi({
      tags: ['Versions'],
      summary: 'List versions for a collection',
      request: { param: z.object({ owner: z.string(), slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const limit = c.req.query('limit')
      const offset = c.req.query('offset')

      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const ownerAccess = await hasOrgAccess(c.get('userId'), collection.organizationId)
      const arkInfo = await getCollectionArkInfo(collection.id).catch(() => null)

      const rows = await db
        .select({
          semver: schema.versions.semver,
          hash: schema.versions.hash,
          publicHash: schema.versions.publicHash,
          message: schema.versions.message,
          appId: schema.versions.appId,
          actorId: schema.versions.actorId,
          recordCount: schema.versions.recordCount,
          fileCount: schema.versions.fileCount,
          totalBytes: schema.versions.totalBytes,
          createdAt: schema.versions.createdAt,
        })
        .from(schema.versions)
        .where(
          and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.status, 'ready')),
        )
        .orderBy(
          sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
        )
        .limit(Math.min(parseInt(limit ?? '50', 10), 100))
        .offset(parseInt(offset ?? '0', 10))

      return c.json(
        rows.map((row) => ({
          semver: row.semver,
          hash: ownerAccess ? row.hash : (row.publicHash ?? row.hash),
          message: row.message,
          appId: row.appId,
          actorId: row.actorId,
          recordCount: row.recordCount,
          fileCount: row.fileCount,
          totalBytes: row.totalBytes,
          createdAt: row.createdAt,
          ark: arkInfo
            ? buildArkUrl(arkInfo.naan, arkInfo.shoulder, arkInfo.arkId, row.semver)
            : null,
        })),
      )
    },
  )
  // Latest version
  .get(
    '/:owner/:slug/versions/latest',
    openApi({
      tags: ['Versions'],
      summary: 'Get the latest version of a collection',
      request: { param: z.object({ owner: z.string(), slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const [version] = await db
        .select()
        .from(schema.versions)
        .where(
          and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.status, 'ready')),
        )
        .orderBy(
          sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
        )
        .limit(1)

      if (!version) return c.json({ error: 'No versions', statusCode: 404 }, 404)

      const schemaEntries = await loadVersionSchemas(version.id)
      const ownerAccess = await hasOrgAccess(c.get('userId'), collection.organizationId)
      const arkInfo = await getCollectionArkInfo(collection.id).catch(() => null)

      const schemasMap = ownerAccess
        ? Object.fromEntries(schemaEntries.map((e) => [e.slug, e.schema]))
        : filterSchemasForPublic(schemaEntries)

      return c.json({
        ...version,
        hash: ownerAccess ? version.hash : (version.publicHash ?? version.hash),
        schemas: schemasMap,
        ark: arkInfo
          ? buildArkUrl(arkInfo.naan, arkInfo.shoulder, arkInfo.arkId, version.semver)
          : null,
      })
    },
  )
  // Get version by semver
  .get(
    '/:owner/:slug/versions/:n',
    openApi({
      tags: ['Versions'],
      summary: 'Get a version by semver',
      request: { param: z.object({ owner: z.string(), slug: z.string(), n: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug, n } = c.req.valid('param')
      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const { semver } = parseSemver(n)
      const [version] = await db
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.collectionId, collection.id),
            eq(schema.versions.semver, semver),
            eq(schema.versions.status, 'ready'),
          ),
        )
        .limit(1)

      if (!version) return c.json({ error: 'Version not found', statusCode: 404 }, 404)

      const schemaEntries = await loadVersionSchemas(version.id)
      const ownerAccess = await hasOrgAccess(c.get('userId'), collection.organizationId)
      const arkInfo = await getCollectionArkInfo(collection.id).catch(() => null)

      const schemasMap = ownerAccess
        ? Object.fromEntries(schemaEntries.map((e) => [e.slug, e.schema]))
        : filterSchemasForPublic(schemaEntries)

      return c.json({
        ...version,
        hash: ownerAccess ? version.hash : (version.publicHash ?? version.hash),
        schemas: schemasMap,
        ark: arkInfo
          ? buildArkUrl(arkInfo.naan, arkInfo.shoulder, arkInfo.arkId, version.semver)
          : null,
      })
    },
  )
  // Get records for a version
  .get(
    '/:owner/:slug/versions/:n/records',
    openApi({
      tags: ['Versions'],
      summary: 'Get records for a version',
      request: { param: z.object({ owner: z.string(), slug: z.string(), n: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug, n } = c.req.valid('param')
      const type = c.req.query('type')
      const limit = c.req.query('limit')
      const offset = c.req.query('offset')
      const after = c.req.query('after')

      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const { semver } = parseSemver(n)
      const [version] = await db
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.collectionId, collection.id),
            eq(schema.versions.semver, semver),
            eq(schema.versions.status, 'ready'),
          ),
        )
        .limit(1)

      if (!version) return c.json({ error: 'Version not found', statusCode: 404 }, 404)

      const conditions = [eq(schema.versionRecords.versionId, version.id)]
      if (type) conditions.push(eq(schema.recordObjects.type, type))

      // Cursor-based pagination: ?after=recordId (keyset pagination)
      if (after) {
        conditions.push(sql`${schema.recordObjects.recordId} > ${after}`)
      }

      // Determine visibility
      const ownerAccess = await hasOrgAccess(c.get('userId'), collection.organizationId)

      let privateTypes = new Set<string>()
      let schemaEntries: SchemaEntry[] = []
      if (!ownerAccess) {
        schemaEntries = await loadVersionSchemas(version.id)
        privateTypes = getPrivateTypes(schemaEntries)

        if (privateTypes.size > 0) {
          if (type && privateTypes.has(type)) {
            return c.json([]) // requesting a private type as non-owner
          }
          for (const pt of privateTypes) {
            conditions.push(sql`${schema.recordObjects.type} != ${pt}`)
          }
        }
        // Exclude record-level private records
        conditions.push(eq(schema.recordObjects.private, false))
      }

      const pageLimit = Math.min(parseInt(limit ?? '100', 10), 1000)

      const records = await db
        .select({
          id: schema.recordObjects.recordId,
          type: schema.recordObjects.type,
          data: schema.recordObjects.data,
          hash: schema.recordObjects.hash,
        })
        .from(schema.versionRecords)
        .innerJoin(
          schema.recordObjects,
          eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
        )
        .where(and(...conditions))
        .orderBy(schema.recordObjects.recordId)
        .limit(pageLimit + 1)
        .offset(after ? 0 : parseInt(offset ?? '0', 10))

      // Determine if there's a next page
      const hasMore = records.length > pageLimit
      const page = hasMore ? records.slice(0, pageLimit) : records
      const nextCursor = hasMore ? page[page.length - 1]!.id : null

      // Strip private fields if not owner
      let resultRecords = page
      if (!ownerAccess) {
        const fieldCache = new Map<string, Set<string>>()
        resultRecords = page.map((rec) => {
          if (!fieldCache.has(rec.type)) {
            const entry = schemaEntries.find((e) => e.slug === rec.type)
            fieldCache.set(rec.type, entry ? getPrivateFields(entry.schema) : new Set())
          }
          const privateFields = fieldCache.get(rec.type)!
          return privateFields.size > 0
            ? { ...rec, data: filterRecordData(rec.data, privateFields) }
            : rec
        })
      }

      // Add ARK URLs for record types that have ARKs enabled
      const arkInfo = await getCollectionArkInfo(collection.id).catch(() => null)
      let arkEnabledTypes = new Map<string, string>() // recordType → redirectUrlField
      if (arkInfo) {
        const artRows = await db
          .select({
            recordType: schema.arkRecordTypes.recordType,
            redirectUrlField: schema.arkRecordTypes.redirectUrlField,
          })
          .from(schema.arkRecordTypes)
          .where(eq(schema.arkRecordTypes.collectionId, collection.id))
        for (const r of artRows) arkEnabledTypes.set(r.recordType, r.redirectUrlField)
      }

      const recordsWithArk = resultRecords.map((rec) => {
        const ark =
          arkInfo && arkEnabledTypes.has(rec.type)
            ? buildArkUrl(
                arkInfo.naan,
                arkInfo.shoulder,
                arkInfo.arkId,
                version.semver,
                rec.type,
                rec.id,
              )
            : null
        return ark ? { ...rec, ark } : rec
      })

      return c.json({
        records: recordsWithArk,
        pagination: {
          limit: pageLimit,
          hasMore,
          nextCursor,
          total: version.recordCount,
        },
      })
    },
  )
  // List files for a version
  .get(
    '/:owner/:slug/versions/:n/files',
    openApi({
      tags: ['Versions'],
      summary: 'List files for a version',
      request: { param: z.object({ owner: z.string(), slug: z.string(), n: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug, n } = c.req.valid('param')
      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const { semver } = parseSemver(n)
      const [version] = await db
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.collectionId, collection.id),
            eq(schema.versions.semver, semver),
            eq(schema.versions.status, 'ready'),
          ),
        )
        .limit(1)

      if (!version) return c.json({ error: 'Version not found', statusCode: 404 }, 404)

      const fileRows = await db
        .select({
          hash: schema.versionFiles.fileHash,
          size: schema.files.size,
          mimeType: schema.files.mimeType,
          createdAt: schema.files.createdAt,
        })
        .from(schema.versionFiles)
        .innerJoin(schema.files, eq(schema.versionFiles.fileHash, schema.files.hash))
        .where(eq(schema.versionFiles.versionId, version.id))

      // Only load records that contain $file references (DB-level filter)
      const fileRefRecords = await db
        .select({
          recordId: schema.recordObjects.recordId,
          type: schema.recordObjects.type,
          data: schema.recordObjects.data,
        })
        .from(schema.versionRecords)
        .innerJoin(
          schema.recordObjects,
          eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
        )
        .where(
          and(
            eq(schema.versionRecords.versionId, version.id),
            sql`${schema.recordObjects.data}::text LIKE '%"$file"%'`,
          ),
        )

      const fileRefs = new Map<string, { recordId: string; type: string; field: string }[]>()
      for (const rec of fileRefRecords) {
        const data = rec.data as Record<string, unknown>
        for (const [field, val] of Object.entries(data)) {
          if (val && typeof val === 'object' && '$file' in (val as any)) {
            const hash = ((val as any).$file as string).replace('sha256:', '')
            if (!fileRefs.has(hash)) fileRefs.set(hash, [])
            fileRefs.get(hash)!.push({ recordId: rec.recordId, type: rec.type, field })
          }
        }
      }

      return c.json(
        fileRows.map((f) => ({
          ...f,
          references: fileRefs.get(f.hash) ?? [],
        })),
      )
    },
  )
  // Get manifest for a version (optionally as delta from a previous version via ?since=N)
  .get(
    '/:owner/:slug/versions/:n/manifest',
    openApi({
      tags: ['Versions'],
      summary: 'Get manifest for a version',
      request: { param: z.object({ owner: z.string(), slug: z.string(), n: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug, n } = c.req.valid('param')
      const sinceParam = c.req.query('since')
      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const { semver } = parseSemver(n)
      const [version] = await db
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.collectionId, collection.id),
            eq(schema.versions.semver, semver),
            eq(schema.versions.status, 'ready'),
          ),
        )
        .limit(1)

      if (!version) return c.json({ error: 'Version not found', statusCode: 404 }, 404)

      const limit = Math.min(parseInt(c.req.query('limit') ?? '10000', 10), 50000)
      const cursor = c.req.query('cursor')

      const fileHashes = await db
        .select({ hash: schema.versionFiles.fileHash })
        .from(schema.versionFiles)
        .where(eq(schema.versionFiles.versionId, version.id))

      const schemaEntries = await loadVersionSchemas(version.id)

      // Delta manifest via SQL set operations — no in-memory Maps
      if (sinceParam) {
        const { semver: sinceSemver } = parseSemver(sinceParam)

        const [sinceVersion] = await db
          .select({ id: schema.versions.id })
          .from(schema.versions)
          .where(
            and(
              eq(schema.versions.collectionId, collection.id),
              eq(schema.versions.semver, sinceSemver),
              eq(schema.versions.status, 'ready'),
            ),
          )
          .limit(1)

        if (!sinceVersion) return c.json({ error: `Version ${sinceSemver} not found` }, 404)

        const targetId = version.id
        const sinceId = sinceVersion.id

        const added = await db
          .select({
            id: schema.recordObjects.recordId,
            type: schema.recordObjects.type,
            hash: schema.recordObjects.hash,
          })
          .from(schema.versionRecords)
          .innerJoin(
            schema.recordObjects,
            eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
          )
          .where(
            and(
              eq(schema.versionRecords.versionId, targetId),
              sql`NOT EXISTS (
                SELECT 1 FROM version_records svr
                INNER JOIN record_objects sro ON svr.record_hash = sro.hash
                WHERE svr.version_id = ${sinceId}
                AND sro.record_id = ${schema.recordObjects.recordId}
              )`,
            ),
          )
          .limit(limit)

        const removed = await db
          .select({
            id: schema.recordObjects.recordId,
            type: schema.recordObjects.type,
            hash: schema.recordObjects.hash,
          })
          .from(schema.versionRecords)
          .innerJoin(
            schema.recordObjects,
            eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
          )
          .where(
            and(
              eq(schema.versionRecords.versionId, sinceId),
              sql`NOT EXISTS (
                SELECT 1 FROM version_records svr
                INNER JOIN record_objects sro ON svr.record_hash = sro.hash
                WHERE svr.version_id = ${targetId}
                AND sro.record_id = ${schema.recordObjects.recordId}
              )`,
            ),
          )
          .limit(limit)

        const updated = await db
          .select({
            id: schema.recordObjects.recordId,
            type: schema.recordObjects.type,
            hash: schema.recordObjects.hash,
            previousHash: sql<string>`(
              SELECT sro.hash FROM version_records svr
              INNER JOIN record_objects sro ON svr.record_hash = sro.hash
              WHERE svr.version_id = ${sinceId}
              AND sro.record_id = ${schema.recordObjects.recordId}
            )`,
          })
          .from(schema.versionRecords)
          .innerJoin(
            schema.recordObjects,
            eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
          )
          .where(
            and(
              eq(schema.versionRecords.versionId, targetId),
              sql`EXISTS (
                SELECT 1 FROM version_records svr
                INNER JOIN record_objects sro ON svr.record_hash = sro.hash
                WHERE svr.version_id = ${sinceId}
                AND sro.record_id = ${schema.recordObjects.recordId}
                AND sro.hash != ${schema.recordObjects.hash}
              )`,
            ),
          )
          .limit(limit)

        const truncated =
          added.length === limit || updated.length === limit || removed.length === limit

        return c.json({
          semver: version.semver,
          hash: version.hash,
          since: sinceSemver,
          schemas: Object.fromEntries(schemaEntries.map((e) => [e.slug, e.schemaHash])),
          delta: { added, updated, removed },
          files: fileHashes.map((f) => f.hash),
          truncated,
        })
      }

      // Full manifest with cursor-based pagination
      const recordConditions = [eq(schema.versionRecords.versionId, version.id)]
      if (cursor) {
        recordConditions.push(sql`${schema.recordObjects.hash} > ${cursor}`)
      }

      const recordRows = await db
        .select({
          id: schema.recordObjects.recordId,
          type: schema.recordObjects.type,
          hash: schema.recordObjects.hash,
        })
        .from(schema.versionRecords)
        .innerJoin(
          schema.recordObjects,
          eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
        )
        .where(and(...recordConditions))
        .orderBy(schema.recordObjects.hash)
        .limit(limit + 1)

      const hasMore = recordRows.length > limit
      const page = hasMore ? recordRows.slice(0, limit) : recordRows
      const nextCursor = hasMore ? page[page.length - 1]!.hash : null

      return c.json({
        semver: version.semver,
        hash: version.hash,
        schemas: Object.fromEntries(schemaEntries.map((e) => [e.slug, e.schemaHash])),
        records: page,
        files: fileHashes.map((f) => f.hash),
        pagination: { limit, hasMore, nextCursor },
      })
    },
  )
  // Diff between versions
  .get(
    '/:owner/:slug/versions/:n/diff',
    openApi({
      tags: ['Versions'],
      summary: 'Diff between versions',
      request: { param: z.object({ owner: z.string(), slug: z.string(), n: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug, n } = c.req.valid('param')
      const from = c.req.query('from')
      const diffLimit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), 5000)

      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const { semver: targetSemver } = parseSemver(n)

      const [targetVersion] = await db
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.collectionId, collection.id),
            eq(schema.versions.semver, targetSemver),
            eq(schema.versions.status, 'ready'),
          ),
        )
        .limit(1)

      if (!targetVersion) {
        return c.json({ error: 'Version not found', statusCode: 404 }, 404)
      }

      const targetId = targetVersion.id
      let fromVersion: typeof targetVersion | null = null
      if (from) {
        const { semver: fromSemver } = parseSemver(from)
        const [fv] = await db
          .select()
          .from(schema.versions)
          .where(
            and(
              eq(schema.versions.collectionId, collection.id),
              eq(schema.versions.semver, fromSemver),
              eq(schema.versions.status, 'ready'),
            ),
          )
          .limit(1)
        if (!fv) return c.json({ error: `Version ${fromSemver} not found`, statusCode: 404 }, 404)
        fromVersion = fv
      }

      const fromId = fromVersion?.id

      // SQL set operations — only fetch diff rows, not all records from both versions
      const added = fromId
        ? await db
            .select({
              id: schema.recordObjects.recordId,
              type: schema.recordObjects.type,
              data: schema.recordObjects.data,
            })
            .from(schema.versionRecords)
            .innerJoin(
              schema.recordObjects,
              eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
            )
            .where(
              and(
                eq(schema.versionRecords.versionId, targetId),
                sql`NOT EXISTS (
                  SELECT 1 FROM version_records svr
                  INNER JOIN record_objects sro ON svr.record_hash = sro.hash
                  WHERE svr.version_id = ${fromId}
                  AND sro.record_id = ${schema.recordObjects.recordId}
                )`,
              ),
            )
            .limit(diffLimit)
        : await db
            .select({
              id: schema.recordObjects.recordId,
              type: schema.recordObjects.type,
              data: schema.recordObjects.data,
            })
            .from(schema.versionRecords)
            .innerJoin(
              schema.recordObjects,
              eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
            )
            .where(eq(schema.versionRecords.versionId, targetId))
            .limit(diffLimit)

      const removed = fromId
        ? await db
            .select({ id: schema.recordObjects.recordId })
            .from(schema.versionRecords)
            .innerJoin(
              schema.recordObjects,
              eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
            )
            .where(
              and(
                eq(schema.versionRecords.versionId, fromId),
                sql`NOT EXISTS (
                  SELECT 1 FROM version_records svr
                  INNER JOIN record_objects sro ON svr.record_hash = sro.hash
                  WHERE svr.version_id = ${targetId}
                  AND sro.record_id = ${schema.recordObjects.recordId}
                )`,
              ),
            )
            .limit(diffLimit)
        : []

      const updated = fromId
        ? await db
            .select({
              id: schema.recordObjects.recordId,
              type: schema.recordObjects.type,
              data: schema.recordObjects.data,
            })
            .from(schema.versionRecords)
            .innerJoin(
              schema.recordObjects,
              eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
            )
            .where(
              and(
                eq(schema.versionRecords.versionId, targetId),
                sql`EXISTS (
                  SELECT 1 FROM version_records svr
                  INNER JOIN record_objects sro ON svr.record_hash = sro.hash
                  WHERE svr.version_id = ${fromId}
                  AND sro.record_id = ${schema.recordObjects.recordId}
                  AND sro.hash != ${schema.recordObjects.hash}
                )`,
              ),
            )
            .limit(diffLimit)
        : []

      // Compare schema sets
      const targetSchemas = await loadVersionSchemas(targetVersion.id)
      const fromSchemas = fromVersion ? await loadVersionSchemas(fromVersion.id) : []
      const targetSchemaMap = new Map(targetSchemas.map((e) => [e.slug, e.schemaHash]))
      const fromSchemaMap = new Map(fromSchemas.map((e) => [e.slug, e.schemaHash]))
      let schemaChanged = targetSchemaMap.size !== fromSchemaMap.size
      if (!schemaChanged) {
        for (const [s, hash] of targetSchemaMap) {
          if (fromSchemaMap.get(s) !== hash) {
            schemaChanged = true
            break
          }
        }
      }

      const metadataChanged =
        JSON.stringify(canonicalize(targetVersion.metadata ?? null)) !==
        JSON.stringify(canonicalize(fromVersion?.metadata ?? null))

      // Compare file sets
      const targetFiles = await db
        .select({ hash: schema.versionFiles.fileHash })
        .from(schema.versionFiles)
        .where(eq(schema.versionFiles.versionId, targetVersion.id))
      const fromFiles = fromVersion
        ? await db
            .select({ hash: schema.versionFiles.fileHash })
            .from(schema.versionFiles)
            .where(eq(schema.versionFiles.versionId, fromVersion.id))
        : []
      const targetFileSet = new Set(targetFiles.map((f) => f.hash))
      const fromFileSet = new Set(fromFiles.map((f) => f.hash))
      const filesAdded = targetFiles.filter((f) => !fromFileSet.has(f.hash)).map((f) => f.hash)
      const filesRemoved = fromFiles.filter((f) => !targetFileSet.has(f.hash)).map((f) => f.hash)

      return c.json({
        from: fromVersion?.semver ?? null,
        to: targetVersion.semver,
        added: added.map((r) => ({ id: r.id, type: r.type, data: r.data })),
        updated: (updated as { id: string; type: string; data: unknown }[]).map((r) => ({
          id: r.id,
          type: r.type,
          data: r.data,
        })),
        removed: (removed as { id: string }[]).map((r) => r.id),
        meta: {
          schemaChanged,
          metadataChanged,
          filesAdded: filesAdded.length,
          filesRemoved: filesRemoved.length,
        },
      })
    },
  )
  // Update version metadata (description, readme, license, etc.) — creates a patch version
  .patch(
    '/:owner/:slug/metadata',
    requireAuth('write'),
    openApi({
      tags: ['Versions'],
      summary: 'Update collection metadata, creating a new patch version',
      request: { param: z.object({ owner: z.string(), slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const body = (await c.req.json()) as Record<string, unknown>

      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const userId = c.get('userId')
      if (!(await hasOrgAccess(userId, collection.organizationId))) {
        return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
      }

      const [latest] = await db
        .select()
        .from(schema.versions)
        .where(
          and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.status, 'ready')),
        )
        .orderBy(
          sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
        )
        .limit(1)

      if (!latest) {
        return c.json({ error: 'No versions exist yet', statusCode: 422 }, 422)
      }

      const prevMetadata = (latest.metadata as Record<string, unknown>) ?? null
      const newMetadata = { ...prevMetadata, ...body }

      if (
        JSON.stringify(canonicalize(newMetadata)) === JSON.stringify(canonicalize(prevMetadata))
      ) {
        return c.json({ semver: latest.semver, unchanged: true })
      }

      const schemaEntries = await loadVersionSchemas(latest.id)
      const schemaSet = schemaEntries.map((e) => ({ slug: e.slug, schemaHash: e.schemaHash }))
      const recordRows = await db
        .select({
          hash: schema.versionRecords.recordHash,
          recordId: schema.recordObjects.recordId,
          type: schema.recordObjects.type,
          data: schema.recordObjects.data,
          private: schema.recordObjects.private,
        })
        .from(schema.versionRecords)
        .innerJoin(
          schema.recordObjects,
          eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
        )
        .where(eq(schema.versionRecords.versionId, latest.id))
      const recordHashes = recordRows.map((r) => r.hash)
      const fileHashes = (
        await db
          .select({ hash: schema.versionFiles.fileHash })
          .from(schema.versionFiles)
          .where(eq(schema.versionFiles.versionId, latest.id))
      ).map((f) => f.hash)

      const versionHash = computeVersionHash(schemaSet, recordHashes, fileHashes, newMetadata)
      const publicHash = computePublicHash(schemaEntries, recordRows, fileHashes, newMetadata)

      const sv = deriveSemver(latest.semver, false, true)

      await db.transaction(async (tx) => {
        const [version] = await tx
          .insert(schema.versions)
          .values({
            collectionId: collection.id,
            semver: sv.semver,
            major: sv.major,
            minor: sv.minor,
            patch: sv.patch,
            hash: versionHash,
            publicHash,
            baseSemver: latest.semver,
            message: `Update metadata`,
            metadata: newMetadata,
            pushedBy: userId ?? null,
            recordCount: latest.recordCount,
            fileCount: latest.fileCount,
            totalBytes: latest.totalBytes,
          })
          .returning({ id: schema.versions.id })

        if (schemaEntries.length > 0) {
          await tx.insert(schema.versionSchemas).values(
            schemaEntries.map((e) => ({
              versionId: version!.id,
              slug: e.slug,
              schemaId: e.schemaId,
            })),
          )
        }

        if (recordHashes.length > 0) {
          await tx
            .insert(schema.versionRecords)
            .values(recordHashes.map((h) => ({ versionId: version!.id, recordHash: h })))
        }

        if (fileHashes.length > 0) {
          await tx
            .insert(schema.versionFiles)
            .values(fileHashes.map((h) => ({ versionId: version!.id, fileHash: h })))
        }

        await tx
          .update(schema.collections)
          .set({ updatedAt: new Date() })
          .where(eq(schema.collections.id, collection.id))
      })

      return c.json({ semver: sv.semver, hash: versionHash, metadata: newMetadata }, 201)
    },
  )

async function getCollectionArkInfo(
  collectionId: string,
): Promise<{ shoulder: string; arkId: string; naan: string } | null> {
  const [row] = await db
    .select({
      shoulder: schema.arkShoulders.shoulder,
      arkId: schema.arkCollections.arkId,
      naan: schema.organization.arkNaan,
    })
    .from(schema.arkCollections)
    .innerJoin(schema.collections, eq(schema.arkCollections.collectionId, schema.collections.id))
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .innerJoin(schema.arkShoulders, eq(schema.arkShoulders.organizationId, schema.organization.id))
    .where(
      and(
        eq(schema.arkCollections.collectionId, collectionId),
        eq(schema.arkCollections.enabled, true),
      ),
    )
    .limit(1)
  if (!row) return null
  return { shoulder: row.shoulder, arkId: row.arkId, naan: row.naan ?? DEFAULT_NAAN }
}

export default app
