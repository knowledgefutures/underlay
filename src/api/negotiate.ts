import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import {
  ajv,
  canonicalize,
  checkSchemaBounds,
  deriveSemver,
  filterRecordData,
  filterTypeSchema,
  findExtraFields,
  getLatestReadyVersion,
  getPrivateFields,
  getPrivateTypes,
  hashRecord,
  hashSchema,
  hasOrgAccess,
  loadVersionSchemas,
  parseSemver,
  resolveCollection,
  type SchemaEntry,
  stripToSchema,
  VersionHashStream,
} from '../lib/version-helpers.server.js'
import {
  bumpTypeFromChanges,
  dispatchDeliveries,
  enqueueWebhookDeliveries,
} from '../lib/webhooks.server.js'
import { requireAuth, type AuthEnv } from './auth.server.js'

const SESSION_TTL_MS = 10 * 60 * 1000
const MAX_BATCH_RECORDS = 10_000

const NegotiateBody = z.object({
  base_version: z.string().nullable().optional(),
  schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  manifest: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      hash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256'),
      private: z.boolean().optional(),
    }),
  ),
  files: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  app_id: z.string().optional(),
  actor_id: z.string().optional(),
  strip_unknown_fields: z.boolean().optional(),
})

async function expireSession(sessionId: string) {
  await db
    .update(schema.negotiateSessions)
    .set({ status: 'expired' })
    .where(eq(schema.negotiateSessions.id, sessionId))
}

const app = new Hono<AuthEnv>()

// POST /api/collections/:owner/:slug/versions/negotiate
app.post(
  '/:owner/:slug/versions/negotiate',
  requireAuth('write'),
  openApi({
    tags: ['Negotiate'],
    summary: 'Start a negotiate session',
    request: {
      param: z.object({ owner: z.string(), slug: z.string() }),
      json: NegotiateBody,
    },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { owner, slug } = c.req.valid('param')
    const body = c.req.valid('json')

    const boundsError = checkSchemaBounds(body.schemas)
    if (boundsError) {
      return c.json({ error: boundsError, statusCode: 422 }, 422)
    }

    const collection = await resolveCollection(owner, slug)
    if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

    if (!(await hasOrgAccess(c.get('userId'), collection.organizationId))) {
      return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
    }

    const scopedCollections = c.get('apiKeyCollectionIds')
    if (scopedCollections && !scopedCollections.includes(collection.id)) {
      return c.json({ error: 'API key is not scoped to this collection', statusCode: 403 }, 403)
    }

    const latest = await getLatestReadyVersion(collection.id)

    const currentSemver = latest?.semver ?? null
    if (body.base_version !== null && body.base_version !== currentSemver) {
      const normalized = body.base_version ? parseSemver(body.base_version).semver : null
      if (normalized !== currentSemver) {
        return c.json(
          { error: 'Version conflict', currentVersion: currentSemver, statusCode: 409 },
          409,
        )
      }
    }

    // Deduplicate manifest entries by hash (PK is sessionId+hash)
    const seenHashes = new Set<string>()
    const dedupedManifest = body.manifest.filter((r) => {
      if (seenHashes.has(r.hash)) return false
      seenHashes.add(r.hash)
      return true
    })

    // Check which record hashes already exist in record_objects (batched for large manifests)
    const manifestHashes = dedupedManifest.map((r) => r.hash)
    const existingRecordSet = new Set<string>()
    const HASH_CHECK_BATCH = 5000
    for (let i = 0; i < manifestHashes.length; i += HASH_CHECK_BATCH) {
      const chunk = manifestHashes.slice(i, i + HASH_CHECK_BATCH)
      const existing = await db
        .select({ hash: schema.recordObjects.hash })
        .from(schema.recordObjects)
        .where(inArray(schema.recordObjects.hash, chunk))
      for (const r of existing) existingRecordSet.add(r.hash)
    }
    const neededRecords = manifestHashes.filter((h) => !existingRecordSet.has(h))

    // Check which file hashes already exist (batched)
    const fileHashes = body.files ?? []
    const existingFileSet = new Set<string>()
    for (let i = 0; i < fileHashes.length; i += HASH_CHECK_BATCH) {
      const chunk = fileHashes.slice(i, i + HASH_CHECK_BATCH)
      const existing = await db
        .select({ hash: schema.files.hash })
        .from(schema.files)
        .where(inArray(schema.files.hash, chunk))
      for (const r of existing) existingFileSet.add(r.hash)
    }
    const neededFiles = fileHashes.filter((h) => !existingFileSet.has(h))

    const [session] = await db
      .insert(schema.negotiateSessions)
      .values({
        collectionId: collection.id,
        userId: c.get('userId')!,
        baseSemver: body.base_version ?? null,
        schemas: body.schemas as any,
        fileHashes,
        neededFiles,
        message: body.message ?? null,
        metadata: body.metadata ?? null,
        appId: body.app_id ?? null,
        actorId: body.actor_id ?? null,
        stripUnknownFields: body.strip_unknown_fields ?? false,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      })
      .returning({ id: schema.negotiateSessions.id })

    // Insert manifest entries into edge table
    const neededSet = new Set(neededRecords)
    const MANIFEST_BATCH = 1000
    for (let i = 0; i < dedupedManifest.length; i += MANIFEST_BATCH) {
      const batch = dedupedManifest.slice(i, i + MANIFEST_BATCH)
      await db.insert(schema.negotiateSessionManifest).values(
        batch.map((r) => ({
          sessionId: session!.id,
          recordId: r.id,
          type: r.type,
          hash: r.hash,
          private: r.private ?? false,
          needed: neededSet.has(r.hash),
        })),
      )
    }

    return c.json({
      session_id: session!.id,
      needed_records: neededRecords,
      needed_files: neededFiles,
      total_records: manifestHashes.length,
      total_files: fileHashes.length,
      already_have_records: manifestHashes.length - neededRecords.length,
      already_have_files: fileHashes.length - neededFiles.length,
    })
  },
)

// GET /api/collections/:owner/:slug/versions/negotiate/:sessionId
app.get(
  '/:owner/:slug/versions/negotiate/:sessionId',
  requireAuth('read'),
  openApi({
    tags: ['Negotiate'],
    summary: 'Get a negotiate session',
    request: {
      param: z.object({ owner: z.string(), slug: z.string(), sessionId: z.string() }),
    },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param')

    const [session] = await db
      .select()
      .from(schema.negotiateSessions)
      .where(eq(schema.negotiateSessions.id, sessionId))
      .limit(1)

    if (!session) {
      return c.json({ error: 'Session not found', statusCode: 404 }, 404)
    }
    if (session.userId !== c.get('userId')) {
      return c.json({ error: 'Not authorized', statusCode: 403 }, 403)
    }

    const [manifestCounts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        needed: sql<number>`count(*) filter (where ${schema.negotiateSessionManifest.needed})::int`,
      })
      .from(schema.negotiateSessionManifest)
      .where(eq(schema.negotiateSessionManifest.sessionId, sessionId))

    return c.json({
      session_id: session.id,
      status: session.status,
      total_records: manifestCounts?.total ?? 0,
      needed_records: manifestCounts?.needed ?? 0,
      needed_files: session.neededFiles,
      expires_at: session.expiresAt,
      created_at: session.createdAt,
    })
  },
)

// POST /api/collections/:owner/:slug/versions/negotiate/:sessionId/records
app.post(
  '/:owner/:slug/versions/negotiate/:sessionId/records',
  requireAuth('write'),
  openApi({
    tags: ['Negotiate'],
    summary: 'Submit records for a negotiate session',
    request: {
      param: z.object({ owner: z.string(), slug: z.string(), sessionId: z.string() }),
    },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param')

    const [sessionRow] = await db
      .select()
      .from(schema.negotiateSessions)
      .where(eq(schema.negotiateSessions.id, sessionId))
      .limit(1)

    if (!sessionRow || sessionRow.status !== 'open' || sessionRow.expiresAt < new Date()) {
      if (sessionRow) {
        await expireSession(sessionId)
      }
      return c.json({ error: 'Session expired or not found', statusCode: 404 }, 404)
    }

    if (sessionRow.userId !== c.get('userId')) {
      return c.json({ error: 'Not authorized', statusCode: 403 }, 403)
    }

    const rawBody = await c.req.text()
    const lines = rawBody
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    if (lines.length === 0) {
      return c.json({ error: 'Empty batch', statusCode: 400 }, 400)
    }
    if (lines.length > MAX_BATCH_RECORDS) {
      return c.json(
        {
          error: `Batch too large. Maximum ${MAX_BATCH_RECORDS} records per request.`,
          statusCode: 400,
        },
        400,
      )
    }

    const submittedRecords: { id: string; type: string; data: unknown; private?: boolean }[] = []
    for (const line of lines) {
      try {
        submittedRecords.push(JSON.parse(line))
      } catch {
        return c.json({ error: `Invalid JSONL line: ${line.slice(0, 100)}`, statusCode: 400 }, 400)
      }
    }

    // Validate submitted records against session schemas
    const sessionSchemas = sessionRow.schemas as Record<string, object>
    const validators = new Map<string, ReturnType<typeof ajv.compile>>()
    for (const [typeSlug, typeSchema] of Object.entries(sessionSchemas)) {
      validators.set(typeSlug, ajv.compile(typeSchema))
    }

    const schemasForCheck: Record<string, { properties?: Record<string, unknown> }> = {}
    for (const [typeSlug, typeSchema] of Object.entries(sessionSchemas)) {
      schemasForCheck[typeSlug] = typeSchema as { properties?: Record<string, unknown> }
    }

    const validationErrors: { recordId: string; type: string; errors: string[] }[] = []
    for (const rec of submittedRecords) {
      const validate = validators.get(rec.type)
      if (!validate) {
        validationErrors.push({
          recordId: rec.id,
          type: rec.type,
          errors: [`No schema defined for record type "${rec.type}"`],
        })
        continue
      }
      if (!validate(rec.data)) {
        validationErrors.push({
          recordId: rec.id,
          type: rec.type,
          errors: (validate.errors ?? []).map(
            (e) => `${e.instancePath || '/'} ${e.message ?? 'validation failed'}`,
          ),
        })
      }
    }

    if (validationErrors.length > 0) {
      return c.json({ error: 'Schema validation failed', validationErrors, statusCode: 422 }, 422)
    }

    // Check for extra fields
    const extraFieldWarnings = findExtraFields(
      submittedRecords.map((r) => ({ recordId: r.id, type: r.type, data: r.data })),
      schemasForCheck,
    )
    if (extraFieldWarnings.length > 0 && !sessionRow.stripUnknownFields) {
      return c.json(
        {
          error: 'Records contain fields not defined in schema',
          extraFields: extraFieldWarnings,
          hint: 'Set strip_unknown_fields: true in the negotiate request to strip these fields.',
          statusCode: 422,
        },
        422,
      )
    }

    // Hash submitted records and collect their hashes for a targeted query
    const hashedRecords: {
      rec: (typeof submittedRecords)[number]
      hash: string
      canonical: string
      data: unknown
    }[] = []
    const batchHashes: string[] = []
    for (const rec of submittedRecords) {
      let data = rec.data
      if (sessionRow.stripUnknownFields) {
        const typeSchema = schemasForCheck[rec.type]
        if (typeSchema?.properties && typeof data === 'object' && data !== null) {
          data = stripToSchema(data as Record<string, unknown>, typeSchema.properties)
        }
      }
      const { hash, canonical } = hashRecord({ id: rec.id, type: rec.type, data })
      hashedRecords.push({ rec, hash, canonical, data })
      batchHashes.push(hash)
    }

    // Query only the hashes present in this batch from the edge table
    const manifestHashSet = new Set<string>()
    const neededSet = new Set<string>()
    for (let i = 0; i < batchHashes.length; i += 5000) {
      const chunk = batchHashes.slice(i, i + 5000)
      const rows = await db
        .select({
          hash: schema.negotiateSessionManifest.hash,
          needed: schema.negotiateSessionManifest.needed,
        })
        .from(schema.negotiateSessionManifest)
        .where(
          and(
            eq(schema.negotiateSessionManifest.sessionId, sessionId),
            inArray(schema.negotiateSessionManifest.hash, chunk),
          ),
        )
      for (const r of rows) {
        manifestHashSet.add(r.hash)
        if (r.needed) neededSet.add(r.hash)
      }
    }

    const receivedHashes = new Set<string>()
    const recordObjects: {
      hash: string
      recordId: string
      type: string
      data: unknown
      private: boolean
      size: number
    }[] = []

    for (const { rec, hash, canonical, data } of hashedRecords) {
      if (!manifestHashSet.has(hash)) {
        return c.json(
          {
            error: 'Unexpected record hash',
            hash,
            recordId: rec.id,
            message: 'Submitted record does not match any hash in the manifest.',
            statusCode: 400,
          },
          400,
        )
      }
      if (neededSet.has(hash)) {
        receivedHashes.add(hash)
        recordObjects.push({
          hash,
          recordId: rec.id,
          type: rec.type,
          data,
          private: rec.private ?? false,
          size: Buffer.byteLength(canonical, 'utf-8'),
        })
      }
    }

    if (recordObjects.length > 0) {
      const BATCH = 1000
      for (let i = 0; i < recordObjects.length; i += BATCH) {
        const batch = recordObjects.slice(i, i + BATCH)
        await db.insert(schema.recordObjects).values(batch).onConflictDoNothing()
      }
    }

    // Mark received hashes as no longer needed (single-row updates, not JSONB rewrite)
    if (receivedHashes.size > 0) {
      await db
        .update(schema.negotiateSessionManifest)
        .set({ needed: false })
        .where(
          and(
            eq(schema.negotiateSessionManifest.sessionId, sessionId),
            inArray(schema.negotiateSessionManifest.hash, [...receivedHashes]),
          ),
        )
    }

    const [remainingRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.negotiateSessionManifest)
      .where(
        and(
          eq(schema.negotiateSessionManifest.sessionId, sessionId),
          eq(schema.negotiateSessionManifest.needed, true),
        ),
      )
    const remaining = remainingRow?.count ?? 0

    return c.json({
      received: receivedHashes.size,
      remaining,
    })
  },
)

// POST /api/collections/:owner/:slug/versions/negotiate/:sessionId/commit
app.post(
  '/:owner/:slug/versions/negotiate/:sessionId/commit',
  requireAuth('write'),
  openApi({
    tags: ['Negotiate'],
    summary: 'Commit a negotiate session',
    request: {
      param: z.object({ owner: z.string(), slug: z.string(), sessionId: z.string() }),
    },
    responses: { 201: z.any() },
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param')
    const userId = c.get('userId')
    const [sessionRow] = await db
      .select()
      .from(schema.negotiateSessions)
      .where(eq(schema.negotiateSessions.id, sessionId))
      .limit(1)

    if (!sessionRow || sessionRow.status !== 'open' || sessionRow.expiresAt < new Date()) {
      if (sessionRow?.status === 'open') {
        await expireSession(sessionId)
      }
      return c.json({ error: 'Session expired or not found', statusCode: 404 }, 404)
    }

    if (sessionRow.userId !== userId) {
      return c.json({ error: 'Not authorized', statusCode: 403 }, 403)
    }

    // Re-verify org membership at commit (it may have been revoked mid-session)
    const [sessionCollection] = await db
      .select({ organizationId: schema.collections.organizationId })
      .from(schema.collections)
      .where(eq(schema.collections.id, sessionRow.collectionId))
      .limit(1)
    if (!sessionCollection || !(await hasOrgAccess(userId, sessionCollection.organizationId))) {
      return c.json({ error: 'Not authorized', statusCode: 403 }, 403)
    }
    const scopedCollections = c.get('apiKeyCollectionIds')
    if (scopedCollections && !scopedCollections.includes(sessionRow.collectionId)) {
      return c.json({ error: 'API key is not scoped to this collection', statusCode: 403 }, 403)
    }

    const session = {
      collectionId: sessionRow.collectionId,
      baseSemver: sessionRow.baseSemver,
      schemas: sessionRow.schemas as Record<string, object>,
      fileHashes: sessionRow.fileHashes,
      neededFiles: sessionRow.neededFiles,
      message: sessionRow.message,
      metadata: sessionRow.metadata as Record<string, unknown> | null,
      appId: sessionRow.appId,
      actorId: sessionRow.actorId,
      stripUnknownFields: sessionRow.stripUnknownFields,
    }

    // Check if any needed records remain
    const [neededCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.negotiateSessionManifest)
      .where(
        and(
          eq(schema.negotiateSessionManifest.sessionId, sessionId),
          eq(schema.negotiateSessionManifest.needed, true),
        ),
      )
    if ((neededCount?.count ?? 0) > 0) {
      const neededRows = await db
        .select({ hash: schema.negotiateSessionManifest.hash })
        .from(schema.negotiateSessionManifest)
        .where(
          and(
            eq(schema.negotiateSessionManifest.sessionId, sessionId),
            eq(schema.negotiateSessionManifest.needed, true),
          ),
        )
        .limit(100)
      return c.json(
        {
          error: 'Missing records',
          missing_hashes: neededRows.map((r) => r.hash),
          message: `${neededCount!.count} needed record(s) have not been submitted. Use POST .../negotiate/${sessionId}/records first.`,
          statusCode: 400,
        },
        400,
      )
    }

    // --- Schema resolution ---
    const newSchemaSet: {
      slug: string
      schemaId: string
      schemaHash: string
      schema: Record<string, unknown>
    }[] = []
    for (const [typeSlug, typeSchema] of Object.entries(session.schemas)) {
      const hash = hashSchema(typeSchema)
      const [existing] = await db
        .select({ id: schema.schemas.id })
        .from(schema.schemas)
        .where(eq(schema.schemas.schemaHash, hash))
        .limit(1)

      let schemaId: string
      if (existing) {
        schemaId = existing.id
      } else {
        const [inserted] = await db
          .insert(schema.schemas)
          .values({ schema: typeSchema as any, schemaHash: hash })
          .returning({ id: schema.schemas.id })
        schemaId = inserted!.id
      }
      newSchemaSet.push({
        slug: typeSlug,
        schemaId,
        schemaHash: hash,
        schema: typeSchema as Record<string, unknown>,
      })
    }

    // Check files exist
    if (session.fileHashes.length > 0) {
      const existingFiles = await db
        .select({ hash: schema.files.hash })
        .from(schema.files)
        .where(inArray(schema.files.hash, session.fileHashes))
      const existingFileSet = new Set(existingFiles.map((f) => f.hash))
      const missingFiles = session.fileHashes.filter((h) => !existingFileSet.has(h))
      if (missingFiles.length > 0) {
        return c.json(
          {
            error: 'Missing files',
            filesNeeded: missingFiles.map((h) => `sha256:${h}`),
            statusCode: 422,
          },
          422,
        )
      }
    }

    // --- Streaming validation + hash accumulation ---
    // Process records in batches instead of loading all into memory at once.
    // Newly submitted records were validated during submitRecords(); existing
    // records are validated here against the current schemas.
    const validators = new Map<string, ReturnType<typeof ajv.compile>>()
    for (const entry of newSchemaSet) {
      validators.set(entry.slug, ajv.compile(entry.schema as object))
    }

    const schemasForCheck: Record<string, { properties?: Record<string, unknown> }> = {}
    for (const entry of newSchemaSet) {
      schemasForCheck[entry.slug] = entry.schema as { properties?: Record<string, unknown> }
    }

    const schemaEntriesForPublicHash: SchemaEntry[] = newSchemaSet.map((e) => ({
      slug: e.slug,
      schemaId: e.schemaId,
      schema: e.schema,
      schemaHash: e.schemaHash,
    }))
    const privateTypes = getPrivateTypes(schemaEntriesForPublicHash)
    const privateFieldsByType = new Map<string, Set<string>>()
    for (const entry of schemaEntriesForPublicHash) {
      const fields = getPrivateFields(entry.schema)
      if (fields.size > 0) privateFieldsByType.set(entry.slug, fields)
    }

    // Walk the manifest in keyset batches, writing each record's outcome back to
    // the session manifest row instead of accumulating it in process. Nothing
    // here grows with collection size: at 3.11M records the old arrays alone
    // (final hashes, public hashes, the manifest itself) ran to several GB.
    const validationErrors: { recordId: string; type: string; errors: string[] }[] = []
    const extraFieldWarnings: { recordId: string; type: string; fields: string[] }[] = []
    // Errors are reported, not accumulated: a schema change that invalidates
    // every record would otherwise build a multi-million-entry response.
    const MAX_REPORTED_ERRORS = 100
    let validationErrorCount = 0
    let extraFieldCount = 0
    let recordCount = 0
    let totalBytes = 0
    // Per-type counts, stored on the version row. The commit already walks every
    // record, so counting here is free and saves a COUNT(*) GROUP BY on every
    // subsequent collection page view.
    const typeCounts = new Map<string, number>()

    // Each batch costs a read plus a write-back, so the round-trip count is what
    // dominates commit wall-clock. 5,000 records of bodies is ~10 MB in flight —
    // bounded, and constant regardless of how large the collection is.
    const LOAD_BATCH = 5000
    let cursor: string | null = null
    for (;;) {
      const batch: {
        hash: string
        manifestPrivate: boolean
        recordId: string
        type: string
        data: unknown
        private: boolean
        size: number
      }[] = await db
        .select({
          hash: schema.negotiateSessionManifest.hash,
          manifestPrivate: schema.negotiateSessionManifest.private,
          recordId: schema.recordObjects.recordId,
          type: schema.recordObjects.type,
          data: schema.recordObjects.data,
          private: schema.recordObjects.private,
          size: schema.recordObjects.size,
        })
        .from(schema.negotiateSessionManifest)
        .innerJoin(
          schema.recordObjects,
          eq(schema.negotiateSessionManifest.hash, schema.recordObjects.hash),
        )
        .where(
          and(
            eq(schema.negotiateSessionManifest.sessionId, sessionId),
            ...(cursor ? [sql`${schema.negotiateSessionManifest.hash} > ${cursor}`] : []),
          ),
        )
        .orderBy(schema.negotiateSessionManifest.hash)
        .limit(LOAD_BATCH)

      if (batch.length === 0) break
      cursor = batch[batch.length - 1]!.hash

      // Per-batch outcomes, flushed to Postgres before the next batch is read.
      const stripped: {
        hash: string
        recordId: string
        type: string
        data: unknown
        private: boolean
        size: number
      }[] = []
      const outcomes: { hash: string; finalHash: string; publicHash: string | null }[] = []

      for (const rec of batch) {
        const validate = validators.get(rec.type)
        if (!validate) {
          validationErrorCount++
          if (validationErrors.length < MAX_REPORTED_ERRORS) {
            validationErrors.push({
              recordId: rec.recordId,
              type: rec.type,
              errors: [`No schema defined for record type "${rec.type}"`],
            })
          }
          continue
        }
        if (!validate(rec.data)) {
          validationErrorCount++
          if (validationErrors.length < MAX_REPORTED_ERRORS) {
            validationErrors.push({
              recordId: rec.recordId,
              type: rec.type,
              errors: (validate.errors ?? []).map(
                (e) => `${e.instancePath || '/'} ${e.message ?? 'validation failed'}`,
              ),
            })
          }
          continue
        }

        let data = rec.data
        let hash = rec.hash
        let size = rec.size

        // Check for extra fields
        const typeSchema = schemasForCheck[rec.type]
        if (typeSchema?.properties && typeof data === 'object' && data !== null) {
          const extra = Object.keys(data).filter((k) => !(k in typeSchema.properties!))
          if (extra.length > 0) {
            if (!session.stripUnknownFields) {
              extraFieldCount++
              if (extraFieldWarnings.length < MAX_REPORTED_ERRORS) {
                extraFieldWarnings.push({ recordId: rec.recordId, type: rec.type, fields: extra })
              }
            } else {
              data = stripToSchema(data as Record<string, unknown>, typeSchema.properties)
              const result = hashRecord({ id: rec.recordId, type: rec.type, data })
              if (hash !== result.hash) {
                hash = result.hash
                size = Buffer.byteLength(result.canonical, 'utf-8')
                stripped.push({
                  hash,
                  recordId: rec.recordId,
                  type: rec.type,
                  data,
                  private: rec.private,
                  size,
                })
              }
            }
          }
        }

        recordCount++
        typeCounts.set(rec.type, (typeCounts.get(rec.type) ?? 0) + 1)
        totalBytes += size

        // Compute the public record hash inline
        const isPrivate = rec.private || rec.manifestPrivate
        let publicHash: string | null = null
        if (!isPrivate && !privateTypes.has(rec.type)) {
          const privateFields = privateFieldsByType.get(rec.type)
          const publicData =
            privateFields && privateFields.size > 0 ? filterRecordData(data, privateFields) : data
          publicHash = hashRecord({ id: rec.recordId, type: rec.type, data: publicData }).hash
        }
        outcomes.push({ hash: rec.hash, finalHash: hash, publicHash })
      }

      // Stop as soon as the push is known to be rejected — there is no point
      // walking millions more records to grow an error list we already capped.
      if (validationErrorCount > 0 || extraFieldCount > 0) break

      if (stripped.length > 0) {
        // Record objects are global, immutable and content-addressed, so writing
        // them before the version exists is safe; a failed commit leaves them
        // orphaned exactly as a failed record submission already does. Conflicts
        // are expected and mean the identical body is already stored — stripping
        // the same records twice is a normal repeat push, not an error.
        await db
          .insert(schema.recordObjects)
          .values(
            stripped.map((r) => ({
              hash: r.hash,
              recordId: r.recordId,
              type: r.type,
              data: r.data as any,
              private: r.private,
              size: r.size,
            })),
          )
          .onConflictDoNothing()
      }

      if (outcomes.length > 0) {
        await db.execute(sql`
          UPDATE negotiate_session_manifest m
          SET final_hash = o.final_hash, public_hash = o.public_hash
          FROM unnest(
            ${sql.param(outcomes.map((o) => o.hash))}::text[],
            ${sql.param(outcomes.map((o) => o.finalHash))}::text[],
            ${sql.param(outcomes.map((o) => o.publicHash))}::text[]
          ) AS o(hash, final_hash, public_hash)
          WHERE m.session_id = ${sessionId} AND m.hash = o.hash
        `)
      }
    }

    if (validationErrorCount > 0) {
      await expireSession(sessionId)
      return c.json(
        {
          error: 'Schema validation failed',
          validationErrors,
          totalErrors: validationErrorCount,
          statusCode: 422,
        },
        422,
      )
    }

    if (extraFieldCount > 0) {
      await expireSession(sessionId)
      return c.json(
        {
          error: 'Records contain fields not defined in schema',
          extraFields: extraFieldWarnings,
          totalRecords: extraFieldCount,
          hint: 'Set strip_unknown_fields: true in the negotiate request to strip these fields.',
          statusCode: 422,
        },
        422,
      )
    }

    // Add file sizes
    if (session.fileHashes.length > 0) {
      const [fileSizeSum] = await db
        .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
        .from(schema.files)
        .where(inArray(schema.files.hash, session.fileHashes))
      totalBytes += Number(fileSizeSum?.total ?? 0)
    }

    // Determine semver
    const latest = await getLatestReadyVersion(session.collectionId)

    const currentSemver = latest?.semver ?? null
    if (session.baseSemver !== null && session.baseSemver !== currentSemver) {
      const normalized = session.baseSemver ? parseSemver(session.baseSemver).semver : null
      if (normalized !== currentSemver) {
        await expireSession(sessionId)
        return c.json(
          { error: 'Version conflict', currentVersion: currentSemver, statusCode: 409 },
          409,
        )
      }
    }

    const prevSchemaEntries = latest ? await loadVersionSchemas(latest.id) : []
    const prevSchemaMap = new Map(prevSchemaEntries.map((e) => [e.slug, e.schemaHash]))
    const newSchemaMap = new Map(newSchemaSet.map((e) => [e.slug, e.schemaHash]))
    let schemaChanged = prevSchemaMap.size !== newSchemaMap.size
    if (!schemaChanged) {
      for (const [s, hash] of newSchemaMap) {
        if (prevSchemaMap.get(s) !== hash) {
          schemaChanged = true
          break
        }
      }
    }

    // Determine if records changed vs previous version. Set comparison done in
    // Postgres: loading the previous version's hashes was a second full-size
    // array on top of everything else.
    let recordsChanged = true
    if (latest) {
      const [cmp] = (await db.execute(sql`
        SELECT
          (SELECT count(DISTINCT final_hash) FROM negotiate_session_manifest
             WHERE session_id = ${sessionId}) AS new_count,
          (SELECT count(*) FROM version_records WHERE version_id = ${latest.id}) AS old_count,
          EXISTS (
            SELECT 1 FROM negotiate_session_manifest m
            WHERE m.session_id = ${sessionId}
              AND NOT EXISTS (
                SELECT 1 FROM version_records vr
                WHERE vr.version_id = ${latest.id} AND vr.record_hash = m.final_hash
              )
          ) AS has_new
      `)) as unknown as { new_count: string; old_count: string; has_new: boolean }[]
      recordsChanged = Number(cmp!.new_count) !== Number(cmp!.old_count) || cmp!.has_new
    }

    const prevMetadata = (latest?.metadata as Record<string, unknown>) ?? null
    const metadataValue = session.metadata
      ? { ...prevMetadata, ...(session.metadata as Record<string, unknown>) }
      : prevMetadata
    const metadataChanged =
      JSON.stringify(metadataValue ? canonicalize(metadataValue) : null) !==
      JSON.stringify(prevMetadata ? canonicalize(prevMetadata) : null)

    const publicSchemaSet: { slug: string; schemaHash: string }[] = []
    for (const entry of schemaEntriesForPublicHash) {
      if (privateTypes.has(entry.slug)) continue
      const filtered = filterTypeSchema(entry.schema)
      publicSchemaSet.push({ slug: entry.slug, schemaHash: hashSchema(filtered) })
    }

    // Both version hashes are folded incrementally over hashes streamed out of
    // Postgres in sorted order, rather than sorting N hashes in memory and
    // stringifying them into one ~200 MB document. VersionHashStream is
    // byte-compatible with computeVersionHash — see its test.
    //
    // COLLATE "C" is required, not cosmetic: the digest must see the hashes in
    // the same order Array.prototype.sort() would produce, which is byte order,
    // not the database's locale collation.
    const versionHashStream = new VersionHashStream(
      newSchemaSet.map((e) => ({ slug: e.slug, schemaHash: e.schemaHash })),
      session.fileHashes,
      metadataValue,
    )
    const publicHashStream = new VersionHashStream(
      publicSchemaSet,
      session.fileHashes,
      metadataValue,
    )

    const HASH_PAGE = 50_000
    for (const [stream, column] of [
      [versionHashStream, sql`final_hash`],
      [publicHashStream, sql`public_hash`],
    ] as const) {
      // Two records that differ only in private fields share a public hash, so
      // the value alone is not a unique cursor — the tiebreak is the manifest's
      // own primary key, or duplicates straddling a page boundary get dropped
      // and the digest silently changes.
      let at: { value: string; tiebreak: string } | null = null
      for (;;) {
        const rows = (await db.execute(sql`
          SELECT ${column} AS h, hash AS tiebreak FROM negotiate_session_manifest
          WHERE session_id = ${sessionId} AND ${column} IS NOT NULL
            ${
              at
                ? sql`AND (${column} COLLATE "C", hash COLLATE "C")
                        > (${at.value} COLLATE "C", ${at.tiebreak} COLLATE "C")`
                : sql``
            }
          ORDER BY ${column} COLLATE "C", hash COLLATE "C"
          LIMIT ${HASH_PAGE}
        `)) as unknown as { h: string; tiebreak: string }[]
        if (rows.length === 0) break
        for (const row of rows) stream.push(row.h)
        if (rows.length < HASH_PAGE) break
        const last = rows[rows.length - 1]!
        at = { value: last.h, tiebreak: last.tiebreak }
      }
    }
    const versionHash = versionHashStream.digest()
    const publicHash = publicHashStream.digest().replace('private:', 'public:')

    const sv = deriveSemver(latest?.semver ?? null, schemaChanged, recordsChanged, metadataChanged)

    // Check for duplicate
    const [existingHash] = await db
      .select({ semver: schema.versions.semver })
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.collectionId, session.collectionId),
          eq(schema.versions.hash, versionHash),
          eq(schema.versions.status, 'ready'),
        ),
      )
      .limit(1)
    if (existingHash) {
      await expireSession(sessionId)
      return c.json(
        {
          error: 'No changes detected',
          message: `Version ${existingHash.semver} already has identical content.`,
          existingVersion: existingHash.semver,
        },
        409,
      )
    }

    // Insert version row + small join tables in a transaction (status = 'creating')
    // Then batch-insert version_records outside the transaction to avoid long locks.
    // Finally mark the version as 'ready'.
    let versionId: number

    await db.transaction(async (tx) => {
      const [version] = await tx
        .insert(schema.versions)
        .values({
          collectionId: session.collectionId,
          semver: sv.semver,
          major: sv.major,
          minor: sv.minor,
          patch: sv.patch,
          hash: versionHash,
          publicHash,
          baseSemver: session.baseSemver,
          message: session.message,
          metadata: metadataValue,
          pushedBy: c.get('userId') ?? null,
          appId: session.appId,
          actorId: session.actorId,
          recordCount,
          fileCount: session.fileHashes.length,
          typeCounts: Object.fromEntries(typeCounts),
          totalBytes,
          status: 'creating',
        })
        .returning()

      versionId = version!.id

      if (session.fileHashes.length > 0) {
        await tx
          .insert(schema.versionFiles)
          .values(session.fileHashes.map((hash) => ({ versionId: versionId, fileHash: hash })))
      }

      await tx.insert(schema.versionSchemas).values(
        newSchemaSet.map((entry) => ({
          versionId: versionId,
          slug: entry.slug,
          schemaId: entry.schemaId,
        })),
      )
    })

    // Populate version_records outside the main transaction, server-side, in
    // keyset batches over the session manifest. Nothing about the record set
    // passes through the app: record_id and type come from record_objects, the
    // hashes and public addresses from the manifest rows the validation pass
    // already wrote. public_record_hash is stored only where it differs from
    // the record hash, which is the column's existing contract.
    try {
      const VR_BATCH = 5000
      let vrCursor: string | null = null
      for (;;) {
        // Resolve the page's upper bound first. Doing it in one statement with
        // RETURNING doesn't work: ON CONFLICT DO NOTHING makes the number of
        // returned rows a count of insertions, not of manifest rows read, so it
        // can't drive the cursor.
        const [bound] = (await db.execute(sql`
          SELECT max(hash) AS hi, count(*)::int AS n FROM (
            SELECT hash FROM negotiate_session_manifest
            WHERE session_id = ${sessionId}
              ${vrCursor ? sql`AND hash > ${vrCursor}` : sql``}
            ORDER BY hash
            LIMIT ${VR_BATCH}
          ) page
        `)) as unknown as { hi: string | null; n: number }[]

        if (!bound || bound.n === 0 || bound.hi === null) break
        const hi = bound.hi

        await db.execute(sql`
          INSERT INTO version_records (version_id, record_hash, public_record_hash, record_id, type)
          SELECT ${versionId!}, ro.hash, nullif(m.public_hash, m.final_hash),
                 ro.record_id, ro.type
          FROM negotiate_session_manifest m
          INNER JOIN record_objects ro ON ro.hash = m.final_hash
          WHERE m.session_id = ${sessionId}
            ${vrCursor ? sql`AND m.hash > ${vrCursor}` : sql``}
            AND m.hash <= ${hi}
          ON CONFLICT DO NOTHING
        `)

        vrCursor = hi
        if (bound.n < VR_BATCH) break
      }
    } catch (err) {
      await db.delete(schema.versions).where(eq(schema.versions.id, versionId!))
      throw err
    }

    // Mark version as ready and update collection timestamp
    await db.transaction(async (tx) => {
      await tx
        .update(schema.versions)
        .set({ status: 'ready' })
        .where(eq(schema.versions.id, versionId!))

      await tx
        .update(schema.collections)
        .set({ updatedAt: new Date() })
        .where(eq(schema.collections.id, session.collectionId))
    })

    await db
      .update(schema.negotiateSessions)
      .set({ status: 'committed' })
      .where(eq(schema.negotiateSessions.id, sessionId))

    // Fire webhooks for the new version — best-effort, never blocks/denies the 201.
    try {
      const deliveryIds = await enqueueWebhookDeliveries(
        {
          id: versionId!,
          semver: sv.semver,
          hash: versionHash,
          major: sv.major,
          minor: sv.minor,
          patch: sv.patch,
          recordCount,
          fileCount: session.fileHashes.length,
        },
        bumpTypeFromChanges(schemaChanged, recordsChanged),
        session.collectionId,
      )
      dispatchDeliveries(deliveryIds)
    } catch (err) {
      console.error(`[webhooks] failed to enqueue for ${sv.semver}:`, err)
    }

    return c.json(
      {
        semver: sv.semver,
        hash: versionHash,
        recordCount,
        fileCount: session.fileHashes.length,
      },
      201,
    )
  },
)

// DELETE /api/collections/:owner/:slug/versions/negotiate/:sessionId
app.delete(
  '/:owner/:slug/versions/negotiate/:sessionId',
  requireAuth('write'),
  openApi({
    tags: ['Negotiate'],
    summary: 'Cancel a negotiate session',
    request: {
      param: z.object({ owner: z.string(), slug: z.string(), sessionId: z.string() }),
    },
    responses: { 204: z.any() },
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param')

    const [session] = await db
      .select()
      .from(schema.negotiateSessions)
      .where(eq(schema.negotiateSessions.id, sessionId))
      .limit(1)

    if (!session) {
      return c.json({ error: 'Session not found', statusCode: 404 }, 404)
    }
    if (session.userId !== c.get('userId')) {
      return c.json({ error: 'Not authorized', statusCode: 403 }, 403)
    }

    await expireSession(sessionId)

    return c.body(null, 204)
  },
)

export default app
