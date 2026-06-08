import { createHash } from 'node:crypto'

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, schema } from '../db/client.server.js'
import { getS3ObjectMeta } from '../lib/s3.js'
import {
  ajv,
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
  type SchemaEntry,
  stripToSchema,
} from '../lib/version-helpers.server.js'
import { type AuthEnv } from './auth.server.js'

/** Deterministic JSON canonicalization for metadata hashing */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return sorted
}

/** Session expiry: 1 hour from creation */
const SESSION_TTL_MS = 60 * 60 * 1000

/** Max records per batch request */
const MAX_BATCH_SIZE = 10_000

async function resolveCollection(owner: string, slug: string) {
  const [result] = await db
    .select({
      id: schema.collections.id,
      organizationId: schema.collections.organizationId,
      slug: schema.collections.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)
  return result ?? null
}

// --- Start a chunked upload session ---
export async function startSession(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!
  const body = await c.req.json<{
    base_version: string | null
    message?: string
    metadata?: Record<string, unknown>
    app_id?: string
    actor_id?: string
    schemas?: Record<string, object>
  }>()

  const collection = await resolveCollection(owner, slug)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

  // Optimistic lock check at session creation time
  const [latest] = await db
    .select({ semver: schema.versions.semver })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collection.id))
    .orderBy(
      sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
    )
    .limit(1)

  const currentSemver = latest?.semver ?? null
  if (body.base_version !== null) {
    const normalizedBase = parseSemver(body.base_version).semver
    const normalizedCurrent = currentSemver ? parseSemver(currentSemver).semver : null
    if (normalizedBase !== normalizedCurrent) {
      return c.json(
        {
          error: 'Version conflict',
          currentVersion: currentSemver,
          statusCode: 409,
        },
        409,
      )
    }
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  const [session] = await db
    .insert(schema.uploadSessions)
    .values({
      collectionId: collection.id,
      userId: c.get('userId')!,
      baseSemver: body.base_version ?? null,
      message: body.message ?? null,
      metadata: body.metadata ? (body.metadata as any) : null,
      appId: body.app_id ?? null,
      actorId: body.actor_id ?? null,
      schemas: body.schemas ? (body.schemas as any) : null,
      status: 'open',
      recordCount: 0,
      expiresAt,
    })
    .returning({ id: schema.uploadSessions.id })

  return c.json(
    {
      sessionId: session!.id,
      expiresAt: expiresAt.toISOString(),
    },
    201,
  )
}

// --- Append a batch of changes to a session ---
export async function appendBatch(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!
  const sessionId = c.req.param('sessionId')!
  const body = await c.req.json<{
    changes: {
      added?: { id: string; type: string; data: unknown; private?: boolean }[]
      updated?: { id: string; type: string; data: unknown; private?: boolean }[]
      removed?: string[]
    }
  }>()

  // Validate session exists and belongs to caller
  const [session] = await db
    .select()
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, sessionId))
    .limit(1)

  if (!session) {
    return c.json({ error: 'Upload session not found', statusCode: 404 }, 404)
  }
  if (session.userId !== c.get('userId')) {
    return c.json({ error: 'Not authorized for this session', statusCode: 403 }, 403)
  }
  if (session.status !== 'open') {
    return c.json(
      {
        error: 'Session is not open',
        status: session.status,
        statusCode: 409,
      },
      409,
    )
  }
  if (new Date(session.expiresAt) < new Date()) {
    await db
      .update(schema.uploadSessions)
      .set({ status: 'expired' })
      .where(eq(schema.uploadSessions.id, sessionId))
    return c.json({ error: 'Upload session expired', statusCode: 410 }, 410)
  }

  // Verify collection matches
  const collection = await resolveCollection(owner, slug)
  if (!collection || collection.id !== session.collectionId) {
    return c.json({ error: 'Collection mismatch', statusCode: 404 }, 404)
  }

  // Count total records in this batch
  const addedCount = body.changes.added?.length ?? 0
  const updatedCount = body.changes.updated?.length ?? 0
  const removedCount = body.changes.removed?.length ?? 0
  const batchSize = addedCount + updatedCount + removedCount

  if (batchSize === 0) {
    return c.json({ error: 'Empty batch', statusCode: 400 }, 400)
  }
  if (batchSize > MAX_BATCH_SIZE) {
    return c.json(
      {
        error: `Batch too large. Maximum ${MAX_BATCH_SIZE} records per batch.`,
        statusCode: 400,
      },
      400,
    )
  }

  // Insert records into staging table (upsert to handle re-sends)
  const rows: {
    sessionId: string
    recordId: string
    type: string | null
    data: any
    private: boolean
    operation: 'add' | 'update' | 'remove'
  }[] = []

  for (const rec of body.changes.added ?? []) {
    rows.push({
      sessionId,
      recordId: rec.id,
      type: rec.type,
      data: rec.data,
      private: rec.private ?? false,
      operation: 'add',
    })
  }
  for (const rec of body.changes.updated ?? []) {
    rows.push({
      sessionId,
      recordId: rec.id,
      type: rec.type,
      data: rec.data,
      private: rec.private ?? false,
      operation: 'update',
    })
  }
  for (const id of body.changes.removed ?? []) {
    rows.push({
      sessionId,
      recordId: id,
      type: null,
      data: null,
      private: false,
      operation: 'remove',
    })
  }

  // Batch insert (upsert: last write wins for same recordId)
  const BATCH = 1000
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    await db
      .insert(schema.uploadRecords)
      .values(batch)
      .onConflictDoUpdate({
        target: [schema.uploadRecords.sessionId, schema.uploadRecords.recordId],
        set: {
          type: sql`excluded.type`,
          data: sql`excluded.data`,
          private: sql`excluded.private`,
          operation: sql`excluded.operation`,
        },
      })
  }

  // Update session record count
  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.uploadRecords)
    .where(eq(schema.uploadRecords.sessionId, sessionId))

  await db
    .update(schema.uploadSessions)
    .set({ recordCount: countResult?.count ?? 0 })
    .where(eq(schema.uploadSessions.id, sessionId))

  return c.json({
    received: { added: addedCount, updated: updatedCount, removed: removedCount },
    totalStaged: countResult?.count ?? 0,
  })
}

// --- Get session status ---
export async function getSession(c: Context<AuthEnv>) {
  const sessionId = c.req.param('sessionId')!

  const [session] = await db
    .select()
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, sessionId))
    .limit(1)

  if (!session) {
    return c.json({ error: 'Upload session not found', statusCode: 404 }, 404)
  }
  if (session.userId !== c.get('userId')) {
    return c.json({ error: 'Not authorized for this session', statusCode: 403 }, 403)
  }

  return c.json({
    sessionId: session.id,
    status: session.status,
    recordCount: session.recordCount,
    baseSemver: session.baseSemver,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  })
}

// --- Finalize: build the version from staged records ---
export async function finalize(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!
  const sessionId = c.req.param('sessionId')!

  // Load and validate session
  const [session] = await db
    .select()
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, sessionId))
    .limit(1)

  if (!session) {
    return c.json({ error: 'Upload session not found', statusCode: 404 }, 404)
  }
  if (session.userId !== c.get('userId')) {
    return c.json({ error: 'Not authorized for this session', statusCode: 403 }, 403)
  }
  if (session.status !== 'open') {
    return c.json(
      {
        error: `Session cannot be finalized (status: ${session.status})`,
        statusCode: 409,
      },
      409,
    )
  }
  if (new Date(session.expiresAt) < new Date()) {
    await db
      .update(schema.uploadSessions)
      .set({ status: 'expired' })
      .where(eq(schema.uploadSessions.id, sessionId))
    return c.json({ error: 'Upload session expired', statusCode: 410 }, 410)
  }

  const collection = await resolveCollection(owner, slug)
  if (!collection || collection.id !== session.collectionId) {
    return c.json({ error: 'Collection mismatch', statusCode: 404 }, 404)
  }

  // Mark session as finalizing
  await db
    .update(schema.uploadSessions)
    .set({ status: 'finalizing' })
    .where(eq(schema.uploadSessions.id, sessionId))

  try {
    // Re-check optimistic lock
    const [latest] = await db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, collection.id))
      .orderBy(
        sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
      )
      .limit(1)

    const currentSemver = latest?.semver ?? null
    if (session.baseSemver !== null) {
      const normalizedBase = parseSemver(session.baseSemver).semver
      const normalizedCurrent = currentSemver ? parseSemver(currentSemver).semver : null
      if (normalizedBase !== normalizedCurrent) {
        await db
          .update(schema.uploadSessions)
          .set({ status: 'failed' })
          .where(eq(schema.uploadSessions.id, sessionId))
        return c.json(
          {
            error: 'Version conflict',
            currentVersion: currentSemver,
            statusCode: 409,
          },
          409,
        )
      }
    }

    // --- Resolve schemas ---
    let prevSchemaEntries: SchemaEntry[] = []
    if (latest) {
      prevSchemaEntries = await loadVersionSchemas(latest.id)
    }

    let schemasInput: Record<string, object>
    if (session.schemas && Object.keys(session.schemas as object).length > 0) {
      schemasInput = session.schemas as Record<string, object>
    } else if (prevSchemaEntries.length > 0) {
      schemasInput = Object.fromEntries(prevSchemaEntries.map((e) => [e.slug, e.schema]))
    } else {
      await db
        .update(schema.uploadSessions)
        .set({ status: 'failed' })
        .where(eq(schema.uploadSessions.id, sessionId))
      return c.json(
        {
          error: 'Schemas required',
          message: 'First version must include a `schemas` map with at least one type definition.',
          statusCode: 422,
        },
        422,
      )
    }

    // Hash and upsert schemas
    const newSchemaSet: {
      slug: string
      schemaId: string
      schemaHash: string
      schema: Record<string, unknown>
    }[] = []
    for (const [typeSlug, typeSchema] of Object.entries(schemasInput)) {
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

    // Check schema changes
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

    // Build validators
    const validators = new Map<string, ReturnType<typeof ajv.compile>>()
    for (const entry of newSchemaSet) {
      validators.set(entry.slug, ajv.compile(entry.schema as object))
    }

    // Get file hashes from previous version
    let existingFileHashes: string[] = []
    if (latest) {
      const vf = await db
        .select({ hash: schema.versionFiles.fileHash })
        .from(schema.versionFiles)
        .where(eq(schema.versionFiles.versionId, latest.id))
      existingFileHashes = vf.map((f) => f.hash)
    }

    // --- Streaming finalize ---
    // Instead of loading all records into memory, we:
    // 1. Materialize the merged record set into a temp table in Postgres
    // 2. Stream through it in sorted batches for validation, hash computation, and insertion
    //
    // The temp table approach lets Postgres handle the merge (existing + staged changes)
    // and gives us sorted cursor access without holding everything in Node memory.

    // Create a temp table with the merged result
    await db.execute(sql`
        CREATE TEMP TABLE _finalize_records (
          record_id text PRIMARY KEY,
          type text NOT NULL,
          data jsonb NOT NULL,
          private boolean NOT NULL DEFAULT false
        )
      `)

    // Insert existing records from base version (if any)
    if (latest) {
      await db.execute(sql`
          INSERT INTO _finalize_records (record_id, type, data, private)
          SELECT ro.record_id, ro.type, ro.data, ro.private
          FROM version_records vr
          INNER JOIN record_objects ro ON vr.record_hash = ro.hash
          WHERE vr.version_id = ${latest.id}
        `)
    }

    // Apply staged changes (upserts and deletes)
    await db.execute(sql`
        INSERT INTO _finalize_records (record_id, type, data, private)
        SELECT record_id, type, data, COALESCE(private, false)
        FROM upload_records
        WHERE session_id = ${sessionId}
          AND operation IN ('add', 'update')
        ON CONFLICT (record_id) DO UPDATE SET
          type = EXCLUDED.type,
          data = EXCLUDED.data,
          private = EXCLUDED.private
      `)

    // Remove deleted records
    await db.execute(sql`
        DELETE FROM _finalize_records
        WHERE record_id IN (
          SELECT record_id FROM upload_records
          WHERE session_id = ${sessionId} AND operation = 'remove'
        )
      `)

    // Get total count
    const [countResult] = await db.execute(sql`SELECT count(*) as cnt FROM _finalize_records`)
    const totalRecordCount = Number((countResult as any).cnt)

    // Check all record types have schemas
    const [typesResult] = await db.execute(sql`SELECT DISTINCT type FROM _finalize_records`)
    // typesResult is an array of rows
    const allTypes: string[] = (Array.isArray(typesResult) ? typesResult : [typesResult])
      .filter(Boolean)
      .map((r: any) => r.type)
    const missingSchemas = allTypes.filter((t) => !(t in schemasInput))
    if (missingSchemas.length > 0) {
      await db
        .update(schema.uploadSessions)
        .set({ status: 'failed' })
        .where(eq(schema.uploadSessions.id, sessionId))
      await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`)
      return c.json(
        {
          error: 'Missing schemas for record types',
          types: missingSchemas,
          statusCode: 422,
        },
        422,
      )
    }

    // --- Stream through records in sorted batches ---
    // Validate, compute record hashes, collect file refs
    const STREAM_BATCH = 5000
    const privateTypes = getPrivateTypes(newSchemaSet as SchemaEntry[])

    const referencedHashes = new Set(existingFileHashes)
    const validationErrors: { recordId: string; type: string; errors: string[] }[] = []
    const allRecordEntries: {
      hash: string
      recordId: string
      type: string
      data: unknown
      private: boolean
      size: number
    }[] = []
    const publicRecordHashes: string[] = []
    let totalBytes = 0
    let hasChanges = false
    let cursor = ''
    let hasMore = true

    // Check if staged records exist (indicates changes)
    const [stagedCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.uploadRecords)
      .where(eq(schema.uploadRecords.sessionId, sessionId))
    hasChanges = (stagedCount?.count ?? 0) > 0

    const metadataValue: Record<string, unknown> | null =
      session.metadata !== null
        ? (session.metadata as Record<string, unknown>)
        : latest?.metadata
          ? (latest.metadata as Record<string, unknown>)
          : null
    const sv = deriveSemver(latest?.semver ?? null, schemaChanged, hasChanges)

    while (hasMore) {
      const batch = (await db.execute(sql`
          SELECT record_id, type, data, private
          FROM _finalize_records
          WHERE record_id > ${cursor}
          ORDER BY record_id ASC
          LIMIT ${STREAM_BATCH}
        `)) as any[]

      const rows = Array.isArray(batch) ? batch : []
      if (rows.length === 0) {
        hasMore = false
        break
      }

      for (const rec of rows) {
        // Validate
        const validate = validators.get(rec.type)
        if (!validate) {
          validationErrors.push({
            recordId: rec.record_id,
            type: rec.type,
            errors: [`No schema defined for record type "${rec.type}"`],
          })
        } else if (!validate(rec.data)) {
          validationErrors.push({
            recordId: rec.record_id,
            type: rec.type,
            errors: (validate.errors ?? []).map(
              (e) => `${e.instancePath || '/'} ${e.message ?? 'validation failed'}`,
            ),
          })
        }

        // Hash the record
        const { hash: recHash, canonical } = hashRecord({
          id: rec.record_id,
          type: rec.type,
          data: rec.data,
        })
        const size = Buffer.byteLength(canonical, 'utf-8')

        allRecordEntries.push({
          hash: recHash,
          recordId: rec.record_id,
          type: rec.type,
          data: rec.data,
          private: rec.private === true,
          size,
        })

        // Track public record hashes for public version hash
        const isPrivateRecord = rec.private === true
        const isPrivateType = privateTypes.has(rec.type)
        if (!isPrivateRecord && !isPrivateType) {
          const entry = newSchemaSet.find((e) => e.slug === rec.type)
          const privFields = entry ? getPrivateFields(entry.schema) : new Set<string>()
          if (privFields.size > 0) {
            const pubData = filterRecordData(rec.data, privFields)
            publicRecordHashes.push(
              hashRecord({ id: rec.record_id, type: rec.type, data: pubData }).hash,
            )
          } else {
            publicRecordHashes.push(recHash)
          }
        }

        totalBytes += size

        // Scan for $file references
        const data = rec.data as Record<string, unknown>
        for (const val of Object.values(data)) {
          if (
            typeof val === 'object' &&
            val !== null &&
            '$file' in val &&
            typeof (val as { $file: string }).$file === 'string'
          ) {
            const fileHash = (val as { $file: string }).$file.replace('sha256:', '')
            referencedHashes.add(fileHash)
          }
        }
      }

      cursor = rows[rows.length - 1].record_id
      if (rows.length < STREAM_BATCH) hasMore = false
    }

    // Bail on validation errors
    if (validationErrors.length > 0) {
      await db
        .update(schema.uploadSessions)
        .set({ status: 'failed' })
        .where(eq(schema.uploadSessions.id, sessionId))
      await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`)
      return c.json(
        {
          error: 'Schema validation failed',
          validationErrors: validationErrors.slice(0, 100), // cap error list
          statusCode: 422,
        },
        422,
      )
    }

    // Check for extra fields not defined in schemas
    const schemasForCheck: Record<string, { properties?: Record<string, unknown> }> = {}
    for (const entry of newSchemaSet) {
      schemasForCheck[entry.slug] = entry.schema as { properties?: Record<string, unknown> }
    }
    const extraFieldWarnings = findExtraFields(
      allRecordEntries.map((r) => ({ recordId: r.recordId, type: r.type, data: r.data })),
      schemasForCheck,
    )
    if (extraFieldWarnings.length > 0) {
      const stripFlag = c.req.query('strip_unknown_fields') === 'true'
      if (!stripFlag) {
        await db
          .update(schema.uploadSessions)
          .set({ status: 'failed' })
          .where(eq(schema.uploadSessions.id, sessionId))
        await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`)
        return c.json(
          {
            error: 'Records contain fields not defined in schema',
            extraFields: extraFieldWarnings.slice(0, 100),
            hint: 'Add ?strip_unknown_fields=true to the finalize URL to accept stripping these fields.',
            statusCode: 422,
          },
          422,
        )
      }
      const affectedIds = new Set(extraFieldWarnings.map((w) => w.recordId))
      for (const rec of allRecordEntries) {
        if (!affectedIds.has(rec.recordId)) continue
        const typeSchema = schemasForCheck[rec.type]
        if (!typeSchema?.properties || typeof rec.data !== 'object' || rec.data === null) continue
        rec.data = stripToSchema(rec.data as Record<string, unknown>, typeSchema.properties)
        const { hash: newHash, canonical } = hashRecord({
          id: rec.recordId,
          type: rec.type,
          data: rec.data,
        })
        rec.hash = newHash
        rec.size = Buffer.byteLength(canonical, 'utf-8')
      }
      // Recompute public record hashes after stripping
      publicRecordHashes.length = 0
      for (const rec of allRecordEntries) {
        const isPrivateRecord = rec.private
        const isPrivateType = privateTypes.has(rec.type)
        if (!isPrivateRecord && !isPrivateType) {
          const entry = newSchemaSet.find((e) => e.slug === rec.type)
          const privFields = entry ? getPrivateFields(entry.schema) : new Set<string>()
          if (privFields.size > 0) {
            const pubData = filterRecordData(rec.data, privFields)
            publicRecordHashes.push(
              hashRecord({ id: rec.recordId, type: rec.type, data: pubData }).hash,
            )
          } else {
            publicRecordHashes.push(rec.hash)
          }
        }
      }
    }

    // Check all referenced files exist
    const allFileHashes = Array.from(referencedHashes)
    if (allFileHashes.length > 0) {
      const existingFiles = await db
        .select({ hash: schema.files.hash })
        .from(schema.files)
        .where(inArray(schema.files.hash, allFileHashes))
      const existingSet = new Set(existingFiles.map((f) => f.hash))
      let filesNeeded = allFileHashes.filter((h) => !existingSet.has(h))

      // For files not in local DB, check if they exist in S3 (shared bucket)
      if (filesNeeded.length > 0) {
        const stillNeeded: string[] = []
        for (const h of filesNeeded) {
          const key = `files/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`
          const meta = await getS3ObjectMeta(key)
          if (meta !== null) {
            await db
              .insert(schema.files)
              .values({
                hash: h,
                size: meta.size,
                mimeType: meta.contentType,
                storageKey: key,
              })
              .onConflictDoNothing()
          } else {
            stillNeeded.push(h)
          }
        }
        filesNeeded = stillNeeded
      }

      if (filesNeeded.length > 0) {
        await db
          .update(schema.uploadSessions)
          .set({ status: 'failed' })
          .where(eq(schema.uploadSessions.id, sessionId))
        await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`)
        return c.json(
          {
            error: 'Missing files',
            filesNeeded: filesNeeded.map((h) => `sha256:${h}`),
            statusCode: 422,
          },
          422,
        )
      }
    }

    // Compute version hashes from record hashes
    const schemaSetForHash = newSchemaSet
      .map((e) => ({ slug: e.slug, schemaHash: e.schemaHash }))
      .sort((a, b) => a.slug.localeCompare(b.slug))
    const publicSchemaSet = newSchemaSet
      .filter((e) => !privateTypes.has(e.slug))
      .map((e) => ({ slug: e.slug, schemaHash: hashSchema(filterTypeSchema(e.schema)) }))
      .sort((a, b) => a.slug.localeCompare(b.slug))

    const allRecordHashes = allRecordEntries.map((r) => r.hash)
    const recordCount = allRecordEntries.length

    const versionHashCanonical = JSON.stringify({
      schemas: Object.fromEntries(schemaSetForHash.map((s) => [s.slug, s.schemaHash])),
      records: [...allRecordHashes].sort(),
      files: allFileHashes.sort(),
      metadata: metadataValue !== null ? canonicalize(metadataValue) : null,
    })
    const versionHash = 'private:' + createHash('sha256').update(versionHashCanonical).digest('hex')

    const publicHashCanonical = JSON.stringify({
      schemas: Object.fromEntries(publicSchemaSet.map((s) => [s.slug, s.schemaHash])),
      records: [...publicRecordHashes].sort(),
      files: allFileHashes.sort(),
      metadata: metadataValue !== null ? canonicalize(metadataValue) : null,
    })
    const publicHash = 'public:' + createHash('sha256').update(publicHashCanonical).digest('hex')

    // Check for duplicate hash
    const [existingHash] = await db
      .select({ semver: schema.versions.semver })
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.hash, versionHash)),
      )
      .limit(1)

    if (existingHash) {
      await db
        .update(schema.uploadSessions)
        .set({ status: 'failed' })
        .where(eq(schema.uploadSessions.id, sessionId))
      await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`)
      return c.json(
        {
          error: 'No changes detected',
          message: `Version ${existingHash.semver} already has identical content`,
          existingVersion: existingHash.semver,
        },
        409,
      )
    }

    // Add file sizes to totalBytes
    if (allFileHashes.length > 0) {
      const [fileSizeSum] = await db
        .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
        .from(schema.files)
        .where(inArray(schema.files.hash, allFileHashes))
      totalBytes += Number(fileSizeSum?.total ?? 0)
    }

    // Insert version
    const [version] = await db
      .insert(schema.versions)
      .values({
        collectionId: collection.id,
        semver: sv.semver,
        major: sv.major,
        minor: sv.minor,
        patch: sv.patch,
        hash: versionHash,
        publicHash,
        baseSemver: session.baseSemver,
        message: session.message ?? null,
        metadata: metadataValue as any,
        pushedBy: c.get('userId') ?? null,
        appId: session.appId ?? null,
        actorId: session.actorId ?? null,
        recordCount,
        fileCount: allFileHashes.length,
        totalBytes,
      })
      .returning()

    // Upsert record objects (content-addressed, deduplicated)
    const RECORD_BATCH = 1000
    for (let i = 0; i < allRecordEntries.length; i += RECORD_BATCH) {
      const batch = allRecordEntries.slice(i, i + RECORD_BATCH)
      await db
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

    // Insert version_records manifest
    for (let i = 0; i < allRecordEntries.length; i += RECORD_BATCH) {
      const batch = allRecordEntries.slice(i, i + RECORD_BATCH)
      await db.insert(schema.versionRecords).values(
        batch.map((r) => ({
          versionId: version!.id,
          recordHash: r.hash,
        })),
      )
    }

    // Clean up temp table
    await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`)

    // Insert version_files
    if (allFileHashes.length > 0) {
      await db.insert(schema.versionFiles).values(
        allFileHashes.map((hash) => ({
          versionId: version!.id,
          fileHash: hash,
        })),
      )
    }

    // Insert version_schemas
    await db.insert(schema.versionSchemas).values(
      newSchemaSet.map((entry) => ({
        versionId: version!.id,
        slug: entry.slug,
        schemaId: entry.schemaId,
      })),
    )

    // Update collection timestamp
    await db
      .update(schema.collections)
      .set({ updatedAt: new Date() })
      .where(eq(schema.collections.id, collection.id))

    // Clean up: delete staged records and the session itself
    await db.delete(schema.uploadRecords).where(eq(schema.uploadRecords.sessionId, sessionId))
    await db.delete(schema.uploadSessions).where(eq(schema.uploadSessions.id, sessionId))

    return c.json(
      {
        semver: sv.semver,
        hash: versionHash,
        recordCount,
        fileCount: allFileHashes.length,
      },
      201,
    )
  } catch (err) {
    // Mark session as failed on unexpected error
    await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`)
    await db
      .update(schema.uploadSessions)
      .set({ status: 'failed' })
      .where(eq(schema.uploadSessions.id, sessionId))
    throw err
  }
}

// --- Abort/cancel a session ---
export async function cancelSession(c: Context<AuthEnv>) {
  const sessionId = c.req.param('sessionId')!

  const [session] = await db
    .select()
    .from(schema.uploadSessions)
    .where(eq(schema.uploadSessions.id, sessionId))
    .limit(1)

  if (!session) {
    return c.json({ error: 'Upload session not found', statusCode: 404 }, 404)
  }
  if (session.userId !== c.get('userId')) {
    return c.json({ error: 'Not authorized for this session', statusCode: 403 }, 403)
  }

  // Delete staged records and session
  await db.delete(schema.uploadRecords).where(eq(schema.uploadRecords.sessionId, sessionId))
  await db.delete(schema.uploadSessions).where(eq(schema.uploadSessions.id, sessionId))

  return c.body(null, 204)
}
