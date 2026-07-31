import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
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

/** Mirrors `c.json(body, status)` so the finalize body reads unchanged. */
const reply = (body: unknown, status: ContentfulStatusCode = 200) => ({ status, body })

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
      // Populated for an async commit: `result` once status is 'committed',
      // `error` once it is 'failed'. Both null while status is 'committing'.
      finalize_started_at: session.finalizeStartedAt,
      result: session.result ?? null,
      error: session.error ?? null,
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

    // Mark received hashes as no longer needed (single-row updates, not JSONB
    // rewrite). `submitted` records this record was validated here, against this
    // session's schemas, so commit can skip revalidating it.
    if (receivedHashes.size > 0) {
      await db
        .update(schema.negotiateSessionManifest)
        .set({ needed: false, submitted: true })
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

    // Opt-in async finalize. Accepted as a query param or a JSON body field so a
    // client can use it without sending a body at all; a commit has no other
    // payload.
    const asyncQuery = c.req.query('async')
    const asyncBody = await c.req.json().catch(() => null)
    const wantsAsync =
      asyncQuery === 'true' ||
      asyncQuery === '1' ||
      (asyncBody !== null && typeof asyncBody === 'object' && asyncBody.async === true)

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

    // Everything past this point is the expensive half of the commit: it walks
    // the record set, folds two digests over it and writes version_records. At a
    // few million records that is minutes, which is too long to hold an HTTP
    // request open — so it is expressed as a value-returning function that the
    // caller either awaits (the default, unchanged behaviour) or runs in the
    // background after answering 202.
    // A rejection inside finalize expires the session synchronously, but in
    // async mode the terminal status is 'failed' and the caller writes it
    // alongside the error body. Expiring here first would briefly publish
    // 'expired', which a poller waiting on committed/failed would either miss or
    // misread as a terminal state of its own.
    const abandonSession = async () => {
      if (!wantsAsync) await expireSession(sessionId)
    }

    const finalize = async (): Promise<{ status: ContentfulStatusCode; body: unknown }> => {
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
        return reply(
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
          return reply(
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

      // The base version, needed early: whether a record still has to be validated
      // depends on whether it was already in the base under an unchanged schema.
      const latest = await getLatestReadyVersion(session.collectionId)

      const currentSemver = latest?.semver ?? null
      if (session.baseSemver !== null && session.baseSemver !== currentSemver) {
        const normalized = session.baseSemver ? parseSemver(session.baseSemver).semver : null
        if (normalized !== currentSemver) {
          await abandonSession()
          return reply(
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

      // Which records appear in the public view. Every input — the manifest's
      // private flag, the record's own flag, the type — is already in Postgres, so
      // this is a predicate rather than a materialized column: writing it to the
      // manifest would mean a full UPDATE pass over every row of every push to
      // record something derivable on the spot.
      //
      // `<> ALL` over an empty array is TRUE, so the type clause needs no special
      // case when nothing is private — which lets the same predicate be written
      // through drizzle and through the raw driver used for the digest cursors.
      const privateTypeList = [...privateTypes]
      const publicRows = sql`NOT m.private AND NOT ro.private
      AND ro.type <> ALL(${sql.param(privateTypeList)}::text[])`

      const validationErrors: { recordId: string; type: string; errors: string[] }[] = []
      const extraFieldWarnings: { recordId: string; type: string; fields: string[] }[] = []
      // Errors are reported, not accumulated: a schema change that invalidates
      // every record would otherwise build a multi-million-entry response.
      const MAX_REPORTED_ERRORS = 100
      let validationErrorCount = 0
      let extraFieldCount = 0

      // Which records still need validating.
      //
      // Records submitted during this session were validated on arrival against
      // these exact schemas, so re-running AJV over them is pure waste — and on a
      // first push that is *every* record. Records inherited from the base version
      // were validated when that version was pushed, so they only need rechecking
      // when the schema set changed. What remains is the genuinely unchecked set:
      // records that were already in record_objects (globally, possibly from
      // another collection) and are new to this collection.
      const revalidateAll = schemaChanged || !latest
      const needsValidation = revalidateAll
        ? sql`NOT m.submitted`
        : sql`NOT m.submitted AND NOT EXISTS (
              SELECT 1 FROM version_records vr
              WHERE vr.version_id = ${latest.id} AND vr.record_hash = m.hash
            )`

      const WALK_BATCH = 5000
      let cursor: string | null = null
      for (;;) {
        const batch = (await db.execute(sql`
        SELECT m.hash, ro.record_id AS "recordId", ro.type, ro.data, ro.private, ro.size
        FROM negotiate_session_manifest m
        INNER JOIN record_objects ro ON ro.hash = m.hash
        WHERE m.session_id = ${sessionId} AND (${needsValidation})
          ${cursor ? sql`AND m.hash > ${cursor}` : sql``}
        ORDER BY m.hash
        LIMIT ${WALK_BATCH}
      `)) as unknown as {
          hash: string
          recordId: string
          type: string
          data: unknown
          private: boolean
          size: number
        }[]

        if (batch.length === 0) break
        cursor = batch[batch.length - 1]!.hash

        // Per-batch outcomes, flushed before the next batch is read. Only records
        // whose hash actually changed are written back — NULL means unchanged, so
        // a push with no stripping performs no UPDATEs.
        const stripped: {
          hash: string
          recordId: string
          type: string
          data: unknown
          private: boolean
          size: number
        }[] = []
        const rehashed: { hash: string; finalHash: string }[] = []

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

          // Check for extra fields
          const typeSchema = schemasForCheck[rec.type]
          if (typeSchema?.properties && typeof rec.data === 'object' && rec.data !== null) {
            const extra = Object.keys(rec.data).filter((k) => !(k in typeSchema.properties!))
            if (extra.length === 0) continue
            if (!session.stripUnknownFields) {
              extraFieldCount++
              if (extraFieldWarnings.length < MAX_REPORTED_ERRORS) {
                extraFieldWarnings.push({ recordId: rec.recordId, type: rec.type, fields: extra })
              }
              continue
            }
            const data = stripToSchema(rec.data as Record<string, unknown>, typeSchema.properties)
            const result = hashRecord({ id: rec.recordId, type: rec.type, data })
            if (result.hash !== rec.hash) {
              stripped.push({
                hash: result.hash,
                recordId: rec.recordId,
                type: rec.type,
                data,
                private: rec.private,
                size: Buffer.byteLength(result.canonical, 'utf-8'),
              })
              rehashed.push({ hash: rec.hash, finalHash: result.hash })
            }
          }
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

          await db.execute(sql`
          UPDATE negotiate_session_manifest m SET final_hash = o.final_hash
          FROM unnest(
            ${sql.param(rehashed.map((o) => o.hash))}::text[],
            ${sql.param(rehashed.map((o) => o.finalHash))}::text[]
          ) AS o(hash, final_hash)
          WHERE m.session_id = ${sessionId} AND m.hash = o.hash
        `)
        }
      }

      if (validationErrorCount > 0) {
        await abandonSession()
        return reply(
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
        await abandonSession()
        return reply(
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

      // Public record addresses. Only types that declare private *fields* can have
      // a public address that differs from the record hash, so this pass reads
      // bodies for those types alone — for a collection with no private fields,
      // which is the normal case, it does nothing at all.
      if (privateFieldsByType.size > 0) {
        const filteredTypes = [...privateFieldsByType.keys()]
        let pubCursor: string | null = null
        for (;;) {
          const batch = (await db.execute(sql`
          SELECT m.hash, ro.record_id AS "recordId", ro.type, ro.data
          FROM negotiate_session_manifest m
          INNER JOIN record_objects ro ON ro.hash = coalesce(m.final_hash, m.hash)
          WHERE m.session_id = ${sessionId} AND (${publicRows})
            AND ro.type = ANY(${sql.param(filteredTypes)}::text[])
            ${pubCursor ? sql`AND m.hash > ${pubCursor}` : sql``}
          ORDER BY m.hash
          LIMIT 5000
        `)) as unknown as { hash: string; recordId: string; type: string; data: unknown }[]

          if (batch.length === 0) break
          pubCursor = batch[batch.length - 1]!.hash

          const updates: { hash: string; publicHash: string }[] = []
          for (const rec of batch) {
            const privateFields = privateFieldsByType.get(rec.type)!
            const publicData = filterRecordData(rec.data, privateFields)
            updates.push({
              hash: rec.hash,
              publicHash: hashRecord({ id: rec.recordId, type: rec.type, data: publicData }).hash,
            })
          }

          await db.execute(sql`
          UPDATE negotiate_session_manifest m SET public_hash = o.public_hash
          FROM unnest(
            ${sql.param(updates.map((u) => u.hash))}::text[],
            ${sql.param(updates.map((u) => u.publicHash))}::text[]
          ) AS o(hash, public_hash)
          WHERE m.session_id = ${sessionId} AND m.hash = o.hash
        `)
        }
      }

      // Record count, per-type counts and byte total, aggregated in Postgres over
      // the final hashes. These used to be tallied in the app during the walk,
      // which only worked because the walk visited every record — it no longer
      // does.
      const typeRows = (await db.execute(sql`
      SELECT ro.type, count(*)::int AS n, sum(ro.size)::bigint AS bytes
      FROM negotiate_session_manifest m
      INNER JOIN record_objects ro ON ro.hash = coalesce(m.final_hash, m.hash)
      WHERE m.session_id = ${sessionId}
      GROUP BY ro.type
    `)) as unknown as { type: string; n: number; bytes: string }[]

      const typeCounts = new Map<string, number>()
      let recordCount = 0
      let totalBytes = 0
      for (const row of typeRows) {
        typeCounts.set(row.type, row.n)
        recordCount += row.n
        totalBytes += Number(row.bytes)
      }

      // Add file sizes
      if (session.fileHashes.length > 0) {
        const [fileSizeSum] = await db
          .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
          .from(schema.files)
          .where(inArray(schema.files.hash, session.fileHashes))
        totalBytes += Number(fileSizeSum?.total ?? 0)
      }

      // Determine if records changed vs previous version. Set comparison done in
      // Postgres: loading the previous version's hashes was a second full-size
      // array on top of everything else.
      let recordsChanged = true
      if (latest) {
        const [cmp] = (await db.execute(sql`
        SELECT
          (SELECT count(DISTINCT coalesce(final_hash, hash)) FROM negotiate_session_manifest
             WHERE session_id = ${sessionId}) AS new_count,
          (SELECT count(*) FROM version_records WHERE version_id = ${latest.id}) AS old_count,
          EXISTS (
            SELECT 1 FROM negotiate_session_manifest m
            WHERE m.session_id = ${sessionId}
              AND NOT EXISTS (
                SELECT 1 FROM version_records vr
                WHERE vr.version_id = ${latest.id}
                  AND vr.record_hash = coalesce(m.final_hash, m.hash)
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

      // A server-side cursor: one sorted scan per digest, delivered in chunks, with
      // no keyset arithmetic to get wrong. The earlier keyset version had to
      // tiebreak on the primary key because two records differing only in private
      // fields share a public hash, and duplicates straddling a page boundary
      // would silently change the digest. A cursor sidesteps that entirely.
      const client = db.$client
      const CURSOR_CHUNK = 10_000

      await client`
      SELECT coalesce(final_hash, hash) AS h
      FROM negotiate_session_manifest
      WHERE session_id = ${sessionId}
      ORDER BY coalesce(final_hash, hash) COLLATE "C"
    `.cursor(CURSOR_CHUNK, (rows) => {
        for (const row of rows) versionHashStream.push(row['h'] as string)
      })

      await client`
      SELECT coalesce(m.public_hash, m.final_hash, m.hash) AS h
      FROM negotiate_session_manifest m
      INNER JOIN record_objects ro ON ro.hash = coalesce(m.final_hash, m.hash)
      WHERE m.session_id = ${sessionId}
        AND NOT m.private AND NOT ro.private
        AND ro.type <> ALL(${privateTypeList}::text[])
      ORDER BY coalesce(m.public_hash, m.final_hash, m.hash) COLLATE "C"
    `.cursor(CURSOR_CHUNK, (rows) => {
        for (const row of rows) publicHashStream.push(row['h'] as string)
      })

      const versionHash = versionHashStream.digest()
      const publicHash = publicHashStream.digest().replace('private:', 'public:')

      const sv = deriveSemver(
        latest?.semver ?? null,
        schemaChanged,
        recordsChanged,
        metadataChanged,
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
        await abandonSession()
        return reply(
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
            pushedBy: userId ?? null,
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
          SELECT ${versionId!}, ro.hash,
                 nullif(coalesce(m.public_hash, m.final_hash, m.hash),
                        coalesce(m.final_hash, m.hash)),
                 ro.record_id, ro.type
          FROM negotiate_session_manifest m
          INNER JOIN record_objects ro ON ro.hash = coalesce(m.final_hash, m.hash)
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

      // In async mode the caller owns the terminal status, so that `status` and
      // `result` land in the same write. Flipping to 'committed' here as well
      // would briefly publish a committed session with a null result, and a
      // client polling on that boundary would read success with nothing in it.
      if (!wantsAsync) {
        await db
          .update(schema.negotiateSessions)
          .set({ status: 'committed' })
          .where(eq(schema.negotiateSessions.id, sessionId))
      }

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

      return reply(
        {
          semver: sv.semver,
          hash: versionHash,
          recordCount,
          fileCount: session.fileHashes.length,
        },
        201,
      )
    }

    // Synchronous by default: the CLI, mirror-sync and every existing client
    // expect the version in the response, and for ordinary collections the whole
    // thing takes well under a second.
    if (!wantsAsync) {
      const { status, body } = await finalize()
      return c.json(body as object, status)
    }

    await db
      .update(schema.negotiateSessions)
      .set({ status: 'committing', finalizeStartedAt: new Date() })
      .where(eq(schema.negotiateSessions.id, sessionId))

    // Deliberately not awaited: the response goes out now and the outcome is
    // recorded on the session for the client to poll. A crash mid-finalize
    // leaves the session in 'committing' and its version in 'creating', which
    // the cleanup job sweeps.
    void (async () => {
      const startedAt = Date.now()
      try {
        const { status, body } = await finalize()
        const ok = status >= 200 && status < 300
        await db
          .update(schema.negotiateSessions)
          .set(
            ok
              ? { status: 'committed', result: body as never }
              : { status: 'failed', error: body as never },
          )
          .where(eq(schema.negotiateSessions.id, sessionId))
        console.log(
          `[negotiate] async finalize ${sessionId} ${ok ? 'committed' : `failed (${status})`} in ${Math.round((Date.now() - startedAt) / 1000)}s`,
        )
      } catch (err) {
        console.error(`[negotiate] async finalize ${sessionId} threw:`, err)
        await db
          .update(schema.negotiateSessions)
          .set({
            status: 'failed',
            error: { statusCode: 500, error: err instanceof Error ? err.message : String(err) },
          })
          .where(eq(schema.negotiateSessions.id, sessionId))
          .catch(() => {})
      }
    })()

    return c.json(
      {
        session_id: sessionId,
        status: 'committing',
        message:
          'Commit accepted. Poll GET .../versions/negotiate/' +
          sessionId +
          ' until status is "committed" or "failed".',
      },
      202,
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
