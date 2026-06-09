import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import {
  ajv,
  canonicalize,
  computeVersionHash,
  deriveSemver,
  filterRecordData,
  filterTypeSchema,
  findExtraFields,
  getPrivateFields,
  getPrivateTypes,
  hashRecord,
  hashSchema,
  loadVersionSchemas,
  parseSemver,
  resolveCollection,
  type SchemaEntry,
  stripToSchema,
} from '../lib/version-helpers.server.js'
import { requireAuth, type AuthEnv } from './auth.server.js'

const SESSION_TTL_MS = 10 * 60 * 1000
const MAX_BATCH_RECORDS = 10_000

const app = new Hono<AuthEnv>()

// POST /api/collections/:owner/:slug/versions/negotiate
app.post(
  '/:owner/:slug/versions/negotiate',
  requireAuth('write'),
  openApi({
    tags: ['Negotiate'],
    summary: 'Start a negotiate session',
    request: { param: z.object({ owner: z.string(), slug: z.string() }) },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { owner, slug } = c.req.valid('param')
    const body = (await c.req.json()) as {
      base_version: string | null
      schemas: Record<string, object>
      manifest: { id: string; type: string; hash: string; private?: boolean }[]
      files?: string[]
      message?: string
      metadata?: Record<string, unknown>
      app_id?: string
      actor_id?: string
      strip_unknown_fields?: boolean
    }

    if (!body.schemas || !body.manifest) {
      return c.json({ error: 'schemas and manifest are required' }, 400)
    }

    const collection = await resolveCollection(owner, slug)
    if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

    const [latest] = await db
      .select({ semver: schema.versions.semver })
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.status, 'ready')),
      )
      .orderBy(
        sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
      )
      .limit(1)

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

    // Check which record hashes already exist in record_objects
    const manifestHashes = body.manifest.map((r) => r.hash)
    let neededRecords: string[] = manifestHashes
    if (manifestHashes.length > 0) {
      const existing = await db
        .select({ hash: schema.recordObjects.hash })
        .from(schema.recordObjects)
        .where(inArray(schema.recordObjects.hash, manifestHashes))
      const existingSet = new Set(existing.map((r) => r.hash))
      neededRecords = manifestHashes.filter((h) => !existingSet.has(h))
    }

    // Check which file hashes already exist
    const fileHashes = body.files ?? []
    let neededFiles: string[] = fileHashes
    if (fileHashes.length > 0) {
      const existing = await db
        .select({ hash: schema.files.hash })
        .from(schema.files)
        .where(inArray(schema.files.hash, fileHashes))
      const existingSet = new Set(existing.map((r) => r.hash))
      neededFiles = fileHashes.filter((h) => !existingSet.has(h))
    }

    const [session] = await db
      .insert(schema.negotiateSessions)
      .values({
        collectionId: collection.id,
        userId: c.get('userId')!,
        baseSemver: body.base_version,
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
    for (let i = 0; i < body.manifest.length; i += MANIFEST_BATCH) {
      const batch = body.manifest.slice(i, i + MANIFEST_BATCH)
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
        await db
          .update(schema.negotiateSessions)
          .set({ status: 'expired' })
          .where(eq(schema.negotiateSessions.id, sessionId))
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

    // Query manifest and needed hashes from edge table
    const manifestRows = await db
      .select({
        hash: schema.negotiateSessionManifest.hash,
        needed: schema.negotiateSessionManifest.needed,
      })
      .from(schema.negotiateSessionManifest)
      .where(eq(schema.negotiateSessionManifest.sessionId, sessionId))

    const manifestHashSet = new Set(manifestRows.map((r) => r.hash))
    const neededSet = new Set(manifestRows.filter((r) => r.needed).map((r) => r.hash))
    const receivedHashes = new Set<string>()
    const recordObjects: {
      hash: string
      recordId: string
      type: string
      data: unknown
      private: boolean
      size: number
    }[] = []

    for (const rec of submittedRecords) {
      let data = rec.data
      // Strip extra fields if requested (before hashing)
      if (sessionRow.stripUnknownFields) {
        const typeSchema = schemasForCheck[rec.type]
        if (typeSchema?.properties && typeof data === 'object' && data !== null) {
          data = stripToSchema(data as Record<string, unknown>, typeSchema.properties)
        }
      }

      const { hash, canonical } = hashRecord({ id: rec.id, type: rec.type, data })
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

    const remainingNeeded = neededSet.size - receivedHashes.size

    return c.json({
      received: receivedHashes.size,
      remaining: remainingNeeded,
      total_needed: neededSet.size,
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
        await db
          .update(schema.negotiateSessions)
          .set({ status: 'expired' })
          .where(eq(schema.negotiateSessions.id, sessionId))
      }
      return c.json({ error: 'Session expired or not found', statusCode: 404 }, 404)
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

    // Load manifest entries from edge table
    const manifestEntries = await db
      .select()
      .from(schema.negotiateSessionManifest)
      .where(eq(schema.negotiateSessionManifest.sessionId, sessionId))

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

    const manifestHashes = manifestEntries.map((r) => r.hash)
    const manifestPrivateMap = new Map(manifestEntries.map((r) => [r.hash, r.private]))
    const finalRecordHashes: string[] = []
    const publicRecordHashes: string[] = []
    const strippedRecordObjects: {
      hash: string
      recordId: string
      type: string
      data: unknown
      private: boolean
      size: number
    }[] = []
    const validationErrors: { recordId: string; type: string; errors: string[] }[] = []
    const extraFieldWarnings: { recordId: string; type: string; fields: string[] }[] = []
    let totalBytes = 0

    const LOAD_BATCH = 1000
    for (let i = 0; i < manifestHashes.length; i += LOAD_BATCH) {
      const batchHashes = manifestHashes.slice(i, i + LOAD_BATCH)
      const rows = await db
        .select({
          hash: schema.recordObjects.hash,
          recordId: schema.recordObjects.recordId,
          type: schema.recordObjects.type,
          data: schema.recordObjects.data,
          private: schema.recordObjects.private,
          size: schema.recordObjects.size,
        })
        .from(schema.recordObjects)
        .where(inArray(schema.recordObjects.hash, batchHashes))

      for (const rec of rows) {
        const validate = validators.get(rec.type)
        if (!validate) {
          validationErrors.push({
            recordId: rec.recordId,
            type: rec.type,
            errors: [`No schema defined for record type "${rec.type}"`],
          })
          continue
        }
        if (!validate(rec.data)) {
          validationErrors.push({
            recordId: rec.recordId,
            type: rec.type,
            errors: (validate.errors ?? []).map(
              (e) => `${e.instancePath || '/'} ${e.message ?? 'validation failed'}`,
            ),
          })
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
              extraFieldWarnings.push({ recordId: rec.recordId, type: rec.type, fields: extra })
            } else {
              data = stripToSchema(data as Record<string, unknown>, typeSchema.properties)
              const result = hashRecord({ id: rec.recordId, type: rec.type, data })
              if (hash !== result.hash) {
                hash = result.hash
                size = Buffer.byteLength(result.canonical, 'utf-8')
                strippedRecordObjects.push({
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

        finalRecordHashes.push(hash)
        totalBytes += size

        // Compute public record hash inline
        const isPrivate = rec.private || manifestPrivateMap.get(rec.hash) || false
        if (!isPrivate && !privateTypes.has(rec.type)) {
          const privateFields = privateFieldsByType.get(rec.type)
          const publicData =
            privateFields && privateFields.size > 0 ? filterRecordData(data, privateFields) : data
          publicRecordHashes.push(
            hashRecord({ id: rec.recordId, type: rec.type, data: publicData }).hash,
          )
        }
      }
    }

    if (validationErrors.length > 0) {
      await db
        .update(schema.negotiateSessions)
        .set({ status: 'expired' })
        .where(eq(schema.negotiateSessions.id, sessionId))
      return c.json({ error: 'Schema validation failed', validationErrors, statusCode: 422 }, 422)
    }

    if (extraFieldWarnings.length > 0) {
      await db
        .update(schema.negotiateSessions)
        .set({ status: 'expired' })
        .where(eq(schema.negotiateSessions.id, sessionId))
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

    // Add file sizes
    if (session.fileHashes.length > 0) {
      const [fileSizeSum] = await db
        .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
        .from(schema.files)
        .where(inArray(schema.files.hash, session.fileHashes))
      totalBytes += Number(fileSizeSum?.total ?? 0)
    }

    // Determine semver
    const [latest] = await db
      .select()
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.collectionId, session.collectionId),
          eq(schema.versions.status, 'ready'),
        ),
      )
      .orderBy(
        sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
      )
      .limit(1)

    const currentSemver = latest?.semver ?? null
    if (session.baseSemver !== null && session.baseSemver !== currentSemver) {
      const normalized = session.baseSemver ? parseSemver(session.baseSemver).semver : null
      if (normalized !== currentSemver) {
        await db
          .update(schema.negotiateSessions)
          .set({ status: 'expired' })
          .where(eq(schema.negotiateSessions.id, sessionId))
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

    // Determine if records changed vs previous version
    let recordsChanged = true
    if (latest) {
      const prevHashes = await db
        .select({ hash: schema.versionRecords.recordHash })
        .from(schema.versionRecords)
        .where(eq(schema.versionRecords.versionId, latest.id))
      const prevSet = new Set(prevHashes.map((r) => r.hash))
      const newSet = new Set(finalRecordHashes)
      recordsChanged = prevSet.size !== newSet.size || [...newSet].some((h) => !prevSet.has(h))
    }

    const prevMetadata = (latest?.metadata as Record<string, unknown>) ?? null
    const metadataValue = session.metadata
      ? { ...(prevMetadata ?? {}), ...(session.metadata as Record<string, unknown>) }
      : prevMetadata
    const metadataChanged =
      JSON.stringify(metadataValue ? canonicalize(metadataValue) : null) !==
      JSON.stringify(prevMetadata ? canonicalize(prevMetadata) : null)

    const schemaSetForHash = newSchemaSet.map((e) => ({ slug: e.slug, schemaHash: e.schemaHash }))
    const versionHash = computeVersionHash(
      schemaSetForHash,
      finalRecordHashes,
      session.fileHashes,
      metadataValue,
    )

    // Compute public hash from pre-accumulated public record hashes
    const publicSchemaSet: { slug: string; schemaHash: string }[] = []
    for (const entry of schemaEntriesForPublicHash) {
      if (privateTypes.has(entry.slug)) continue
      const filtered = filterTypeSchema(entry.schema)
      publicSchemaSet.push({ slug: entry.slug, schemaHash: hashSchema(filtered) })
    }
    const publicHash = computeVersionHash(
      publicSchemaSet,
      publicRecordHashes,
      session.fileHashes,
      metadataValue,
    ).replace('private:', 'public:')

    const sv = deriveSemver(
      latest?.semver ?? null,
      schemaChanged,
      recordsChanged || metadataChanged,
    )

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
      await db
        .update(schema.negotiateSessions)
        .set({ status: 'expired' })
        .where(eq(schema.negotiateSessions.id, sessionId))
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
          recordCount: finalRecordHashes.length,
          fileCount: session.fileHashes.length,
          totalBytes,
          status: 'creating',
        })
        .returning()

      versionId = version!.id

      if (strippedRecordObjects.length > 0) {
        const BATCH = 1000
        for (let i = 0; i < strippedRecordObjects.length; i += BATCH) {
          const batch = strippedRecordObjects.slice(i, i + BATCH)
          await tx
            .insert(schema.recordObjects)
            .values(
              batch.map((r) => ({
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
      }

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

    // Batch-insert version_records outside the main transaction
    const VR_BATCH = 5000
    for (let i = 0; i < finalRecordHashes.length; i += VR_BATCH) {
      const batch = finalRecordHashes.slice(i, i + VR_BATCH)
      await db
        .insert(schema.versionRecords)
        .values(batch.map((hash) => ({ versionId: versionId!, recordHash: hash })))
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

    return c.json(
      {
        semver: sv.semver,
        hash: versionHash,
        recordCount: finalRecordHashes.length,
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

    await db
      .update(schema.negotiateSessions)
      .set({ status: 'expired' })
      .where(eq(schema.negotiateSessions.id, sessionId))

    return c.body(null, 204)
  },
)

export default app
