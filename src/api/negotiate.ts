import { createHash } from 'node:crypto'

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, schema } from '../db/client.server.js'
import {
  ajv,
  deriveSemver,
  filterRecordData,
  filterTypeSchema,
  getPrivateFields,
  getPrivateTypes,
  hashRecord,
  hashSchema,
  loadVersionSchemas,
  type SchemaEntry,
} from '../lib/version-helpers.server.js'
import { type AuthEnv } from './auth.server.js'

// In-memory negotiate sessions (short-lived, expires in 10 minutes)
const sessions = new Map<
  string,
  {
    collectionId: string
    owner: string
    slug: string
    baseVersion: number | null
    schemas: Record<string, object>
    manifest: { id: string; type: string; hash: string; private?: boolean }[]
    fileHashes: string[]
    neededRecords: string[]
    neededFiles: string[]
    message: string | null
    readme: string | null
    appId: string | null
    actorId: string | null
    expiresAt: number
  }
>()

const SESSION_TTL_MS = 10 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(key)
  }
}, 60 * 1000)

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

function computeVersionHash(
  schemaSet: { slug: string; schemaHash: string }[],
  recordHashes: string[],
  fileHashes: string[],
  readme: string | null,
): string {
  const canonical = JSON.stringify({
    schemas: Object.fromEntries(
      schemaSet.sort((a, b) => a.slug.localeCompare(b.slug)).map((s) => [s.slug, s.schemaHash]),
    ),
    records: [...recordHashes].sort(),
    files: fileHashes.sort(),
    readme: readme ?? null,
  })
  return 'private:' + createHash('sha256').update(canonical).digest('hex')
}

function computePublicHash(
  schemaEntries: SchemaEntry[],
  recordRows: { recordId: string; type: string; data: unknown; private: boolean }[],
  fileHashes: string[],
  readme: string | null,
): string {
  const privateTypes = getPrivateTypes(schemaEntries)
  const publicSchemaSet: { slug: string; schemaHash: string }[] = []
  for (const entry of schemaEntries) {
    if (privateTypes.has(entry.slug)) continue
    const filtered = filterTypeSchema(entry.schema)
    publicSchemaSet.push({ slug: entry.slug, schemaHash: hashSchema(filtered) })
  }
  const publicRecordHashes = recordRows
    .filter((r) => !r.private && !privateTypes.has(r.type))
    .map((r) => {
      const entry = schemaEntries.find((e) => e.slug === r.type)
      const privateFields = entry ? getPrivateFields(entry.schema) : new Set<string>()
      const data = privateFields.size > 0 ? filterRecordData(r.data, privateFields) : r.data
      return hashRecord({ id: r.recordId, type: r.type, data }).hash
    })
  return computeVersionHash(publicSchemaSet, publicRecordHashes, fileHashes, readme).replace(
    'private:',
    'public:',
  )
}

// POST /api/collections/:owner/:slug/versions/negotiate
export async function negotiate(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!
  const body = (await c.req.json()) as {
    base_version: number | null
    schemas: Record<string, object>
    manifest: { id: string; type: string; hash: string; private?: boolean }[]
    files?: string[]
    message?: string
    readme?: string
    app_id?: string
    actor_id?: string
  }

  if (!body.schemas || !body.manifest) {
    return c.json({ error: 'schemas and manifest are required' }, 400)
  }

  const collection = await resolveCollection(owner, slug)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

  // Check latest version for optimistic lock
  const [latest] = await db
    .select({ number: schema.versions.number })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collection.id))
    .orderBy(sql`${schema.versions.number} desc`)
    .limit(1)

  const currentNumber = latest?.number ?? 0
  if (body.base_version !== null && body.base_version !== currentNumber) {
    return c.json(
      { error: 'Version conflict', currentVersion: currentNumber, statusCode: 409 },
      409,
    )
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

  const sessionId = crypto.randomUUID()
  sessions.set(sessionId, {
    collectionId: collection.id,
    owner,
    slug,
    baseVersion: body.base_version,
    schemas: body.schemas,
    manifest: body.manifest,
    fileHashes,
    neededRecords,
    neededFiles,
    message: body.message ?? null,
    readme: body.readme ?? null,
    appId: body.app_id ?? null,
    actorId: body.actor_id ?? null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  })

  return c.json({
    session_id: sessionId,
    needed_records: neededRecords,
    needed_files: neededFiles,
    total_records: manifestHashes.length,
    total_files: fileHashes.length,
    already_have_records: manifestHashes.length - neededRecords.length,
    already_have_files: fileHashes.length - neededFiles.length,
  })
}

// POST /api/collections/:owner/:slug/versions/negotiate/:sessionId/commit
export async function commit(c: Context<AuthEnv>) {
  const sessionId = c.req.param('sessionId')!
  const session = sessions.get(sessionId)

  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId)
    return c.json({ error: 'Session expired or not found', statusCode: 404 }, 404)
  }

  // Parse JSONL body
  const rawBody = await c.req.text()
  const lines = rawBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const submittedRecords: {
    id: string
    type: string
    data: unknown
    private?: boolean
  }[] = []
  for (const line of lines) {
    try {
      submittedRecords.push(JSON.parse(line))
    } catch {
      sessions.delete(sessionId)
      return c.json({ error: `Invalid JSONL line: ${line.slice(0, 100)}`, statusCode: 400 }, 400)
    }
  }

  // Verify submitted records hash to expected values
  const neededSet = new Set(session.neededRecords)
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
    const { hash, canonical } = hashRecord({ id: rec.id, type: rec.type, data: rec.data })
    if (!neededSet.has(hash)) {
      sessions.delete(sessionId)
      return c.json(
        {
          error: 'Unexpected record hash',
          hash,
          recordId: rec.id,
          message: 'Submitted record does not match any needed hash from the negotiate step.',
          statusCode: 400,
        },
        400,
      )
    }
    receivedHashes.add(hash)
    recordObjects.push({
      hash,
      recordId: rec.id,
      type: rec.type,
      data: rec.data,
      private: rec.private ?? false,
      size: Buffer.byteLength(canonical, 'utf-8'),
    })
  }

  // Check all needed records were provided
  const missing = session.neededRecords.filter((h) => !receivedHashes.has(h))
  if (missing.length > 0) {
    return c.json(
      {
        error: 'Missing records',
        missing_hashes: missing,
        message: `${missing.length} needed record(s) were not submitted.`,
        statusCode: 400,
      },
      400,
    )
  }

  // Build manifest lookup for private flags
  const manifestMap = new Map(session.manifest.map((r) => [r.hash, r]))

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

  // Validate ALL records against schemas (both new and existing)
  const validators = new Map<string, ReturnType<typeof ajv.compile>>()
  for (const entry of newSchemaSet) {
    validators.set(entry.slug, ajv.compile(entry.schema as object))
  }

  // Build the full record list for validation + version creation
  // For records we already had, load them from record_objects
  const existingHashes = session.manifest.map((r) => r.hash).filter((h) => !neededSet.has(h))
  let existingRecords: {
    hash: string
    recordId: string
    type: string
    data: unknown
    private: boolean
    size: number
  }[] = []
  if (existingHashes.length > 0) {
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
      .where(inArray(schema.recordObjects.hash, existingHashes))
    existingRecords = rows
  }

  const allRecords = [...existingRecords, ...recordObjects]

  // Validate
  const validationErrors: { recordId: string; type: string; errors: string[] }[] = []
  for (const rec of allRecords) {
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
    }
  }

  if (validationErrors.length > 0) {
    sessions.delete(sessionId)
    return c.json({ error: 'Schema validation failed', validationErrors, statusCode: 422 }, 422)
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

  // Determine version number + semver
  const [latest] = await db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, session.collectionId))
    .orderBy(sql`${schema.versions.number} desc`)
    .limit(1)

  const currentNumber = latest?.number ?? 0
  if (session.baseVersion !== null && session.baseVersion !== currentNumber) {
    sessions.delete(sessionId)
    return c.json(
      { error: 'Version conflict', currentVersion: currentNumber, statusCode: 409 },
      409,
    )
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
    const newSet = new Set(session.manifest.map((r) => r.hash))
    recordsChanged = prevSet.size !== newSet.size || [...newSet].some((h) => !prevSet.has(h))
  }

  const readmeValue = session.readme !== undefined ? session.readme : (latest?.readme ?? null)
  const schemaSetForHash = newSchemaSet.map((e) => ({ slug: e.slug, schemaHash: e.schemaHash }))
  const allRecordHashes = session.manifest.map((r) => r.hash)
  const versionHash = computeVersionHash(
    schemaSetForHash,
    allRecordHashes,
    session.fileHashes,
    readmeValue,
  )

  const schemaEntriesForPublicHash: SchemaEntry[] = newSchemaSet.map((e) => ({
    slug: e.slug,
    schemaId: e.schemaId,
    schema: e.schema,
    schemaHash: e.schemaHash,
  }))
  const publicHash = computePublicHash(
    schemaEntriesForPublicHash,
    allRecords.map((r) => ({
      recordId: r.recordId,
      type: r.type,
      data: r.data,
      private: r.private,
    })),
    session.fileHashes,
    readmeValue,
  )

  const semver = deriveSemver(latest?.semver ?? null, schemaChanged, recordsChanged)
  const newNumber = currentNumber + 1

  // Check for duplicate
  const [existingHash] = await db
    .select({ number: schema.versions.number })
    .from(schema.versions)
    .where(
      and(
        eq(schema.versions.collectionId, session.collectionId),
        eq(schema.versions.hash, versionHash),
      ),
    )
    .limit(1)
  if (existingHash) {
    sessions.delete(sessionId)
    return c.json(
      {
        error: 'No changes detected',
        message: `Version ${existingHash.number} already has identical content.`,
        existingVersion: existingHash.number,
      },
      409,
    )
  }

  // Compute total bytes
  let totalBytes = 0
  for (const rec of allRecords) totalBytes += rec.size
  if (session.fileHashes.length > 0) {
    const [fileSizeSum] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
      .from(schema.files)
      .where(inArray(schema.files.hash, session.fileHashes))
    totalBytes += Number(fileSizeSum?.total ?? 0)
  }

  // Insert version
  const [version] = await db
    .insert(schema.versions)
    .values({
      collectionId: session.collectionId,
      number: newNumber,
      semver,
      hash: versionHash,
      publicHash,
      baseNumber: session.baseVersion,
      message: session.message,
      readme: readmeValue,
      pushedBy: c.get('userId') ?? null,
      appId: session.appId,
      actorId: session.actorId,
      recordCount: allRecords.length,
      fileCount: session.fileHashes.length,
      totalBytes,
    })
    .returning()

  // Upsert new record objects
  if (recordObjects.length > 0) {
    const BATCH = 1000
    for (let i = 0; i < recordObjects.length; i += BATCH) {
      const batch = recordObjects.slice(i, i + BATCH)
      await db.insert(schema.recordObjects).values(batch).onConflictDoNothing()
    }
  }

  // Insert version_records manifest
  const BATCH = 1000
  for (let i = 0; i < session.manifest.length; i += BATCH) {
    const batch = session.manifest.slice(i, i + BATCH)
    await db
      .insert(schema.versionRecords)
      .values(batch.map((r) => ({ versionId: version!.id, recordHash: r.hash })))
  }

  // Insert version_files
  if (session.fileHashes.length > 0) {
    await db
      .insert(schema.versionFiles)
      .values(session.fileHashes.map((hash) => ({ versionId: version!.id, fileHash: hash })))
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
    .where(eq(schema.collections.id, session.collectionId))

  // Clean up session
  sessions.delete(sessionId)

  return c.json(
    {
      version: newNumber,
      semver,
      hash: versionHash,
      recordCount: allRecords.length,
      fileCount: session.fileHashes.length,
      records_transferred: recordObjects.length,
      records_deduplicated: allRecords.length - recordObjects.length,
    },
    201,
  )
}
