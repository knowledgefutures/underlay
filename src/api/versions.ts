import { and, eq, inArray, sql, } from 'drizzle-orm'
import type { Context, } from 'hono'
import { createHash, } from 'node:crypto'
import { db, schema, } from '../db/client.server.js'
import { buildArkUrl, DEFAULT_NAAN, } from '../lib/ark.js'
import {
  ajv,
  deriveSemver,
  filterRecordData,
  filterTypeSchema,
  getPrivateFields,
  getPrivateTypes,
  hashSchema,
  loadVersionSchemas,
  type SchemaEntry,
} from '../lib/version-helpers.server.js'
import { type AuthEnv, } from './auth.server.js'

/** Build a public-facing schemas map (excluding private types, stripping private fields) */
function filterSchemasForPublic(schemaEntries: SchemaEntry[],): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const entry of schemaEntries) {
    if ((entry.schema as any)?.private === true) continue
    result[entry.slug] = filterTypeSchema(entry.schema,)
  }
  return result
}

/** Check if requester is the owner of a collection */
function isOwner(accountId: string | undefined, collectionAccountId: string,): boolean {
  return accountId != null && accountId === collectionAccountId
}

function computeVersionHash(
  schemaSet: { slug: string; schemaHash: string }[],
  recordRows: { recordId: string; type: string; data: unknown }[],
  fileHashes: string[],
  readme: string | null,
): string {
  const canonical = JSON.stringify({
    schemas: Object.fromEntries(
      schemaSet.sort((a, b,) => a.slug.localeCompare(b.slug,)).map((s,) => [s.slug, s.schemaHash,]),
    ),
    records: recordRows
      .sort((a, b,) => a.recordId.localeCompare(b.recordId,))
      .map((r,) => ({ id: r.recordId, type: r.type, data: r.data, })),
    files: fileHashes.sort(),
    readme: readme ?? null,
  },)
  return 'private:' + createHash('sha256',).update(canonical,).digest('hex',)
}

/** Compute a public hash that only covers non-private content */
function computePublicHash(
  schemaEntries: SchemaEntry[],
  recordRows: { recordId: string; type: string; data: unknown; private: boolean }[],
  fileHashes: string[],
  readme: string | null,
): string {
  const privateTypes = getPrivateTypes(schemaEntries,)

  // Build public schema set (non-private types, with private fields stripped)
  const publicSchemaSet: { slug: string; schemaHash: string }[] = []
  for (const entry of schemaEntries) {
    if (privateTypes.has(entry.slug,)) continue
    const filtered = filterTypeSchema(entry.schema,)
    publicSchemaSet.push({ slug: entry.slug, schemaHash: hashSchema(filtered,), },)
  }

  // Filter to public records only, and strip private fields
  const publicRecords = recordRows
    .filter((r,) => !r.private && !privateTypes.has(r.type,))
    .map((r,) => {
      const entry = schemaEntries.find((e,) => e.slug === r.type)
      const privateFields = entry ? getPrivateFields(entry.schema,) : new Set<string>()
      const data = privateFields.size > 0 ? filterRecordData(r.data, privateFields,) : r.data
      return { id: r.recordId, type: r.type, data, }
    },)
    .sort((a, b,) => a.id.localeCompare(b.id,))

  const canonical = JSON.stringify({
    schemas: Object.fromEntries(
      publicSchemaSet.sort((a, b,) => a.slug.localeCompare(b.slug,)).map((s,) => [s.slug, s.schemaHash,]),
    ),
    records: publicRecords,
    files: fileHashes.sort(),
    readme: readme ?? null,
  },)
  return 'public:' + createHash('sha256',).update(canonical,).digest('hex',)
}

// Lazily backfill totalBytes for versions that were created before we tracked it
// or where the value was corrupted by a string concatenation bug
async function backfillTotalBytes(version: { id: number; totalBytes: number; recordCount: number },) {
  // Skip recomputation if totalBytes looks reasonable (> 0 and < 1TB)
  if (version.totalBytes > 0 && version.totalBytes < 1_099_511_627_776 || version.recordCount === 0) {
    return version.totalBytes
  }

  const records = await db
    .select({ data: schema.records.data, },)
    .from(schema.records,)
    .where(eq(schema.records.versionId, version.id,),)

  let totalBytes = 0
  for (const r of records) {
    totalBytes += Buffer.byteLength(JSON.stringify(r.data,), 'utf-8',)
  }

  const [fileSizeResult,] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)`, },)
    .from(schema.versionFiles,)
    .innerJoin(schema.files, eq(schema.versionFiles.fileHash, schema.files.hash,),)
    .where(eq(schema.versionFiles.versionId, version.id,),)
  totalBytes += Number(fileSizeResult?.total ?? 0,)

  // Persist so we don't recompute next time
  await db
    .update(schema.versions,)
    .set({ totalBytes, },)
    .where(eq(schema.versions.id, version.id,),)

  return totalBytes
}

// List versions
export async function list(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const limit = c.req.query('limit',)
  const offset = c.req.query('offset',)

  const collection = await resolveCollection(owner, slug,)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404, }, 404,)

  const accountId = c.get('accountId',)
  const ownerAccess = isOwner(accountId, collection.accountId,)
  const arkInfo = await getCollectionArkInfo(collection.id,).catch(() => null)

  const rows = await db
    .select({
      number: schema.versions.number,
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
    },)
    .from(schema.versions,)
    .where(eq(schema.versions.collectionId, collection.id,),)
    .orderBy(sql`${schema.versions.number} desc`,)
    .limit(Math.min(parseInt(limit ?? '50', 10,), 100,),)
    .offset(parseInt(offset ?? '0', 10,),)

  return c.json(rows.map((row,) => ({
    number: row.number,
    semver: row.semver,
    hash: ownerAccess ? row.hash : (row.publicHash ?? row.hash),
    message: row.message,
    appId: row.appId,
    actorId: row.actorId,
    recordCount: row.recordCount,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    createdAt: row.createdAt,
    ark: arkInfo ? buildArkUrl(arkInfo.naan, arkInfo.shoulder, arkInfo.arkId, row.number,) : null,
  })),)
}

// Latest version
export async function latest(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const collection = await resolveCollection(owner, slug,)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404, }, 404,)

  const [version,] = await db
    .select()
    .from(schema.versions,)
    .where(eq(schema.versions.collectionId, collection.id,),)
    .orderBy(sql`${schema.versions.number} desc`,)
    .limit(1,)

  if (!version) return c.json({ error: 'No versions', statusCode: 404, }, 404,)
  version.totalBytes = await backfillTotalBytes(version,)

  const schemaEntries = await loadVersionSchemas(version.id,)
  const accountId = c.get('accountId',)
  const ownerAccess = isOwner(accountId, collection.accountId,)
  const arkInfo = await getCollectionArkInfo(collection.id,).catch(() => null)

  const schemasMap = ownerAccess
    ? Object.fromEntries(schemaEntries.map((e,) => [e.slug, e.schema,]),)
    : filterSchemasForPublic(schemaEntries,)

  return c.json({
    ...version,
    hash: ownerAccess ? version.hash : (version.publicHash ?? version.hash),
    schemas: schemasMap,
    ark: arkInfo ? buildArkUrl(arkInfo.naan, arkInfo.shoulder, arkInfo.arkId, version.number,) : null,
  },)
}

// Get version by number
export async function getByNumber(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const n = c.req.param('n',)!
  const collection = await resolveCollection(owner, slug,)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404, }, 404,)

  const [version,] = await db
    .select()
    .from(schema.versions,)
    .where(
      and(eq(schema.versions.collectionId, collection.id,), eq(schema.versions.number, parseInt(n, 10,),),),
    )
    .limit(1,)

  if (!version) return c.json({ error: 'Version not found', statusCode: 404, }, 404,)
  version.totalBytes = await backfillTotalBytes(version,)

  const schemaEntries = await loadVersionSchemas(version.id,)
  const accountId = c.get('accountId',)
  const ownerAccess = isOwner(accountId, collection.accountId,)
  const arkInfo = await getCollectionArkInfo(collection.id,).catch(() => null)

  const schemasMap = ownerAccess
    ? Object.fromEntries(schemaEntries.map((e,) => [e.slug, e.schema,]),)
    : filterSchemasForPublic(schemaEntries,)

  return c.json({
    ...version,
    hash: ownerAccess ? version.hash : (version.publicHash ?? version.hash),
    schemas: schemasMap,
    ark: arkInfo ? buildArkUrl(arkInfo.naan, arkInfo.shoulder, arkInfo.arkId, version.number,) : null,
  },)
}

// Get records for a version
export async function records(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const n = c.req.param('n',)!
  const type = c.req.query('type',)
  const limit = c.req.query('limit',)
  const offset = c.req.query('offset',)
  const after = c.req.query('after',)

  const collection = await resolveCollection(owner, slug,)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404, }, 404,)

  const [version,] = await db
    .select()
    .from(schema.versions,)
    .where(
      and(eq(schema.versions.collectionId, collection.id,), eq(schema.versions.number, parseInt(n, 10,),),),
    )
    .limit(1,)

  if (!version) return c.json({ error: 'Version not found', statusCode: 404, }, 404,)

  const conditions = [eq(schema.records.versionId, version.id,),]
  if (type) conditions.push(eq(schema.records.type, type,),)

  // Cursor-based pagination: ?after=recordId (keyset pagination)
  if (after) {
    conditions.push(sql`${schema.records.recordId} > ${after}`,)
  }

  // Determine visibility
  const accountId = c.get('accountId',)
  const ownerAccess = isOwner(accountId, collection.accountId,)

  let privateTypes = new Set<string>()
  let schemaEntries: SchemaEntry[] = []
  if (!ownerAccess) {
    schemaEntries = await loadVersionSchemas(version.id,)
    privateTypes = getPrivateTypes(schemaEntries,)

    if (privateTypes.size > 0) {
      if (type && privateTypes.has(type,)) {
        return c.json([],) // requesting a private type as non-owner
      }
      for (const pt of privateTypes) {
        conditions.push(sql`${schema.records.type} != ${pt}`,)
      }
    }
    // Exclude record-level private records
    conditions.push(eq(schema.records.private, false,),)
  }

  const pageLimit = Math.min(parseInt(limit ?? '100', 10,), 1000,)

  const records = await db
    .select({
      id: schema.records.recordId,
      type: schema.records.type,
      data: schema.records.data,
    },)
    .from(schema.records,)
    .where(and(...conditions,),)
    .orderBy(schema.records.recordId,)
    .limit(pageLimit + 1,)
    .offset(after ? 0 : parseInt(offset ?? '0', 10,),)

  // Determine if there's a next page
  const hasMore = records.length > pageLimit
  const page = hasMore ? records.slice(0, pageLimit,) : records
  const nextCursor = hasMore ? page[page.length - 1]!.id : null

  // Strip private fields if not owner
  let resultRecords = page
  if (!ownerAccess) {
    const fieldCache = new Map<string, Set<string>>()
    resultRecords = page.map((rec,) => {
      if (!fieldCache.has(rec.type,)) {
        const entry = schemaEntries.find((e,) => e.slug === rec.type)
        fieldCache.set(rec.type, entry ? getPrivateFields(entry.schema,) : new Set(),)
      }
      const privateFields = fieldCache.get(rec.type,)!
      return privateFields.size > 0
        ? { ...rec, data: filterRecordData(rec.data, privateFields,), }
        : rec
    },)
  }

  // Add ARK URLs for record types that have ARKs enabled
  const arkInfo = await getCollectionArkInfo(collection.id,).catch(() => null)
  let arkEnabledTypes = new Map<string, string>() // recordType → redirectUrlField
  if (arkInfo) {
    const artRows = await db
      .select({
        recordType: schema.arkRecordTypes.recordType,
        redirectUrlField: schema.arkRecordTypes.redirectUrlField,
      },)
      .from(schema.arkRecordTypes,)
      .where(eq(schema.arkRecordTypes.collectionId, collection.id,),)
    for (const r of artRows) arkEnabledTypes.set(r.recordType, r.redirectUrlField,)
  }

  const recordsWithArk = resultRecords.map((rec,) => {
    const ark = arkInfo && arkEnabledTypes.has(rec.type,)
      ? buildArkUrl(arkInfo.naan, arkInfo.shoulder, arkInfo.arkId, version.number, rec.type, rec.id,)
      : null
    return ark ? { ...rec, ark, } : rec
  },)

  return c.json({
    records: recordsWithArk,
    pagination: {
      limit: pageLimit,
      hasMore,
      nextCursor,
      total: version.recordCount,
    },
  },)
}

// List files for a version
export async function files(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const n = c.req.param('n',)!
  const collection = await resolveCollection(owner, slug,)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404, }, 404,)

  const [version,] = await db
    .select()
    .from(schema.versions,)
    .where(
      and(eq(schema.versions.collectionId, collection.id,), eq(schema.versions.number, parseInt(n, 10,),),),
    )
    .limit(1,)

  if (!version) return c.json({ error: 'Version not found', statusCode: 404, }, 404,)

  const fileRows = await db
    .select({
      hash: schema.versionFiles.fileHash,
      size: schema.files.size,
      mimeType: schema.files.mimeType,
      createdAt: schema.files.createdAt,
    },)
    .from(schema.versionFiles,)
    .innerJoin(schema.files, eq(schema.versionFiles.fileHash, schema.files.hash,),)
    .where(eq(schema.versionFiles.versionId, version.id,),)

  // Build file→record reference map by scanning record data for $file refs
  const allRecords = await db
    .select({ recordId: schema.records.recordId, type: schema.records.type, data: schema.records.data, },)
    .from(schema.records,)
    .where(eq(schema.records.versionId, version.id,),)

  const fileRefs = new Map<string, { recordId: string; type: string; field: string }[]>()
  for (const rec of allRecords) {
    const data = rec.data as Record<string, unknown>
    for (const [field, val,] of Object.entries(data,)) {
      if (val && typeof val === 'object' && '$file' in (val as any)) {
        const hash = ((val as any).$file as string).replace('sha256:', '',)
        if (!fileRefs.has(hash,)) fileRefs.set(hash, [],)
        fileRefs.get(hash,)!.push({ recordId: rec.recordId, type: rec.type, field, },)
      }
    }
  }

  return c.json(fileRows.map((f,) => ({
    ...f,
    references: fileRefs.get(f.hash,) ?? [],
  })),)
}

// Get manifest for a version
export async function manifest(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const n = c.req.param('n',)!
  const collection = await resolveCollection(owner, slug,)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404, }, 404,)

  const [version,] = await db
    .select()
    .from(schema.versions,)
    .where(
      and(eq(schema.versions.collectionId, collection.id,), eq(schema.versions.number, parseInt(n, 10,),),),
    )
    .limit(1,)

  if (!version) return c.json({ error: 'Version not found', statusCode: 404, }, 404,)

  const recordIds = await db
    .select({ id: schema.records.recordId, type: schema.records.type, },)
    .from(schema.records,)
    .where(eq(schema.records.versionId, version.id,),)

  const fileHashes = await db
    .select({ hash: schema.versionFiles.fileHash, },)
    .from(schema.versionFiles,)
    .where(eq(schema.versionFiles.versionId, version.id,),)

  const schemaEntries = await loadVersionSchemas(version.id,)

  return c.json({
    version: version.number,
    semver: version.semver,
    hash: version.hash,
    schemas: Object.fromEntries(schemaEntries.map((e,) => [e.slug, e.schemaHash,]),),
    records: recordIds,
    files: fileHashes.map((f,) => f.hash),
  },)
}

// Push a new version
export async function push(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const body = await c.req.json() as {
    base_version: number | null
    name?: string
    description?: string
    message?: string
    readme?: string
    app_id?: string
    actor_id?: string
    schemas?: Record<string, object>
    changes: {
      added?: { id: string; type: string; data: unknown; private?: boolean }[]
      updated?: { id: string; type: string; data: unknown; private?: boolean }[]
      removed?: string[]
    }
  }

  const collection = await resolveCollection(owner, slug,)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404, }, 404,)

  // Get latest version
  const [latest,] = await db
    .select()
    .from(schema.versions,)
    .where(eq(schema.versions.collectionId, collection.id,),)
    .orderBy(sql`${schema.versions.number} desc`,)
    .limit(1,)

  const currentNumber = latest?.number ?? 0

  // Optimistic lock
  if (body.base_version !== null && body.base_version !== currentNumber) {
    return c.json({
      error: 'Version conflict',
      currentVersion: currentNumber,
      statusCode: 409,
    }, 409,)
  }

  // Build the full record set for this version
  let existingRecords: { recordId: string; type: string; data: unknown; private: boolean }[] = []
  if (latest) {
    existingRecords = await db
      .select({
        recordId: schema.records.recordId,
        type: schema.records.type,
        data: schema.records.data,
        private: schema.records.private,
      },)
      .from(schema.records,)
      .where(eq(schema.records.versionId, latest.id,),)
  }

  // Apply changes
  const recordMap = new Map(existingRecords.map((r,) => [r.recordId, r,]),)

  for (const rec of body.changes.added ?? []) {
    recordMap.set(rec.id, { recordId: rec.id, type: rec.type, data: rec.data, private: rec.private ?? false, },)
  }
  for (const rec of body.changes.updated ?? []) {
    recordMap.set(rec.id, { recordId: rec.id, type: rec.type, data: rec.data, private: rec.private ?? false, },)
  }
  for (const id of body.changes.removed ?? []) {
    recordMap.delete(id,)
  }

  const newRecords = Array.from(recordMap.values(),)

  // --- Resolve schemas ---
  let prevSchemaEntries: SchemaEntry[] = []
  if (latest) {
    prevSchemaEntries = await loadVersionSchemas(latest.id,)
  }

  // Determine the schema set for this version
  let schemasInput: Record<string, object>
  if (body.schemas && Object.keys(body.schemas,).length > 0) {
    schemasInput = body.schemas
  } else if (prevSchemaEntries.length > 0) {
    // Carry forward previous schemas
    schemasInput = Object.fromEntries(prevSchemaEntries.map((e,) => [e.slug, e.schema,]),)
  } else {
    return c.json({
      error: 'Schemas required',
      message: 'First version must include a `schemas` map with at least one type definition.',
      statusCode: 422,
    }, 422,)
  }

  // Ensure every record type has a schema
  const recordTypes = new Set(newRecords.map((r,) => r.type),)
  const missingSchemas = [...recordTypes,].filter((t,) => !(t in schemasInput))
  if (missingSchemas.length > 0) {
    return c.json({
      error: 'Missing schemas for record types',
      types: missingSchemas,
      message: `Every record type must have a corresponding schema. Missing: ${missingSchemas.join(', ',)}`,
      statusCode: 422,
    }, 422,)
  }

  // Hash and upsert each schema into the global schemas table
  const newSchemaSet: { slug: string; schemaId: string; schemaHash: string; schema: Record<string, unknown> }[] = []
  for (const [typeSlug, typeSchema,] of Object.entries(schemasInput,)) {
    const hash = hashSchema(typeSchema,)

    const [existing,] = await db
      .select({ id: schema.schemas.id, },)
      .from(schema.schemas,)
      .where(eq(schema.schemas.schemaHash, hash,),)
      .limit(1,)

    let schemaId: string
    if (existing) {
      schemaId = existing.id
    } else {
      const [inserted,] = await db
        .insert(schema.schemas,)
        .values({ schema: typeSchema as any, schemaHash: hash, },)
        .returning({ id: schema.schemas.id, },)
      schemaId = inserted!.id
    }

    newSchemaSet.push({ slug: typeSlug, schemaId, schemaHash: hash, schema: typeSchema as Record<string, unknown>, },)
  }

  // Validate records against their type's schema
  const validationErrors: { recordId: string; type: string; errors: string[] }[] = []
  const validators = new Map<string, ReturnType<typeof ajv.compile>>()
  for (const entry of newSchemaSet) {
    validators.set(entry.slug, ajv.compile(entry.schema as object,),)
  }

  for (const rec of newRecords) {
    const validate = validators.get(rec.type,)
    if (!validate) {
      validationErrors.push({
        recordId: rec.recordId,
        type: rec.type,
        errors: [`No schema defined for record type "${rec.type}"`,],
      },)
      continue
    }
    if (!validate(rec.data,)) {
      validationErrors.push({
        recordId: rec.recordId,
        type: rec.type,
        errors: (validate.errors ?? []).map(
          (e,) => `${e.instancePath || '/'} ${e.message ?? 'validation failed'}`,
        ),
      },)
    }
  }

  if (validationErrors.length > 0) {
    return c.json({
      error: 'Schema validation failed',
      validationErrors,
      statusCode: 422,
    }, 422,)
  }

  // Determine if schema set changed
  const prevSchemaMap = new Map(prevSchemaEntries.map((e,) => [e.slug, e.schemaHash,]),)
  const newSchemaMap = new Map(newSchemaSet.map((e,) => [e.slug, e.schemaHash,]),)
  let schemaChanged = prevSchemaMap.size !== newSchemaMap.size
  if (!schemaChanged) {
    for (const [s, hash,] of newSchemaMap) {
      if (prevSchemaMap.get(s,) !== hash) {
        schemaChanged = true
        break
      }
    }
  }

  const recordsChanged = (body.changes.added?.length ?? 0) > 0
    || (body.changes.updated?.length ?? 0) > 0
    || (body.changes.removed?.length ?? 0) > 0

  // Get file hashes from existing version + any new references
  let existingFileHashes: string[] = []
  if (latest) {
    const vf = await db
      .select({ hash: schema.versionFiles.fileHash, },)
      .from(schema.versionFiles,)
      .where(eq(schema.versionFiles.versionId, latest.id,),)
    existingFileHashes = vf.map((f,) => f.hash)
  }

  // Scan new records for $file references
  const referencedHashes = new Set(existingFileHashes,)
  for (const rec of newRecords) {
    const data = rec.data as Record<string, unknown>
    for (const val of Object.values(data,)) {
      if (
        typeof val === 'object'
        && val !== null
        && '$file' in val
        && typeof (val as { $file: string }).$file === 'string'
      ) {
        const hash = (val as { $file: string }).$file.replace('sha256:', '',)
        referencedHashes.add(hash,)
      }
    }
  }

  // Check all referenced files exist
  const allFileHashes = Array.from(referencedHashes,)
  if (allFileHashes.length > 0) {
    const existingFiles = await db
      .select({ hash: schema.files.hash, },)
      .from(schema.files,)
      .where(inArray(schema.files.hash, allFileHashes,),)
    const existingSet = new Set(existingFiles.map((f,) => f.hash),)
    const filesNeeded = allFileHashes.filter((h,) => !existingSet.has(h,))

    if (filesNeeded.length > 0) {
      return c.json({
        error: 'Missing files',
        filesNeeded: filesNeeded.map((h,) => `sha256:${h}`),
        statusCode: 422,
      }, 422,)
    }
  }

  // Resolve readme (carry forward from base version if not provided)
  const readmeValue = body.readme !== undefined ? body.readme : (latest?.readme ?? null)

  // Compute hashes and semver
  const schemaSetForHash = newSchemaSet.map((e,) => ({ slug: e.slug, schemaHash: e.schemaHash, }))
  const versionHash = computeVersionHash(schemaSetForHash, newRecords, allFileHashes, readmeValue,)

  const schemaEntriesForPublicHash: SchemaEntry[] = newSchemaSet.map((e,) => ({
    slug: e.slug,
    schemaId: e.schemaId,
    schema: e.schema,
    schemaHash: e.schemaHash,
  }))
  const publicHash = computePublicHash(schemaEntriesForPublicHash, newRecords, allFileHashes, readmeValue,)

  const semver = deriveSemver(latest?.semver ?? null, schemaChanged, recordsChanged,)
  const newNumber = currentNumber + 1

  // Check for duplicate hash
  const [existingHash,] = await db
    .select({ number: schema.versions.number, },)
    .from(schema.versions,)
    .where(
      and(
        eq(schema.versions.collectionId, collection.id,),
        eq(schema.versions.hash, versionHash,),
      ),
    )
    .limit(1,)
  if (existingHash) {
    return c.json({
      error: 'No changes detected',
      message: `Version ${existingHash.number} already has identical content (hash: ${versionHash.slice(0, 12,)}...)`,
      existingVersion: existingHash.number,
    }, 409,)
  }

  // Compute total bytes
  let totalBytes = 0
  for (const rec of newRecords) {
    totalBytes += Buffer.byteLength(JSON.stringify(rec.data,), 'utf-8',)
  }
  if (allFileHashes.length > 0) {
    const [fileSizeSum,] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)`, },)
      .from(schema.files,)
      .where(inArray(schema.files.hash, allFileHashes,),)
    totalBytes += Number(fileSizeSum?.total ?? 0,)
  }

  // Insert version
  const [version,] = await db
    .insert(schema.versions,)
    .values({
      collectionId: collection.id,
      number: newNumber,
      semver,
      hash: versionHash,
      publicHash,
      baseNumber: body.base_version,
      message: body.message ?? null,
      readme: readmeValue,
      pushedBy: c.get('accountId',) ?? null,
      appId: body.app_id ?? null,
      actorId: body.actor_id ?? null,
      recordCount: newRecords.length,
      fileCount: allFileHashes.length,
      totalBytes,
    },)
    .returning()

  // Insert records (in batches)
  if (newRecords.length > 0) {
    const RECORD_BATCH = 1000
    for (let i = 0; i < newRecords.length; i += RECORD_BATCH) {
      const batch = newRecords.slice(i, i + RECORD_BATCH,)
      await db.insert(schema.records,).values(
        batch.map((r,) => ({
          versionId: version!.id,
          recordId: r.recordId,
          type: r.type,
          data: r.data as any,
          private: r.private,
        })),
      )
    }
  }

  // Insert version_files
  if (allFileHashes.length > 0) {
    await db.insert(schema.versionFiles,).values(
      allFileHashes.map((hash,) => ({
        versionId: version!.id,
        fileHash: hash,
      })),
    )
  }

  // Insert version_schemas
  await db.insert(schema.versionSchemas,).values(
    newSchemaSet.map((entry,) => ({
      versionId: version!.id,
      slug: entry.slug,
      schemaId: entry.schemaId,
    })),
  )

  // Update collection timestamp + optional name/description
  const collectionUpdates: Record<string, unknown> = { updatedAt: new Date(), }
  if (body.name) collectionUpdates.name = body.name
  if (body.description !== undefined) collectionUpdates.description = body.description
  await db
    .update(schema.collections,)
    .set(collectionUpdates,)
    .where(eq(schema.collections.id, collection.id,),)

  return c.json({
    version: newNumber,
    semver,
    hash: versionHash,
    recordCount: newRecords.length,
    fileCount: allFileHashes.length,
  }, 201,)
}

// Diff between versions
export async function diff(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const n = c.req.param('n',)!
  const from = c.req.query('from',)

  const collection = await resolveCollection(owner, slug,)
  if (!collection) return c.json({ error: 'Collection not found', statusCode: 404, }, 404,)

  const targetNum = parseInt(n, 10,)
  const fromNum = from ? parseInt(from, 10,) : targetNum - 1

  const [targetVersion,] = await db
    .select()
    .from(schema.versions,)
    .where(and(eq(schema.versions.collectionId, collection.id,), eq(schema.versions.number, targetNum,),),)
    .limit(1,)

  if (!targetVersion) {
    return c.json({ error: 'Version not found', statusCode: 404, }, 404,)
  }

  const targetRecords = await db
    .select()
    .from(schema.records,)
    .where(eq(schema.records.versionId, targetVersion.id,),)

  let fromVersion: typeof targetVersion | null = null
  let fromRecords: typeof targetRecords = []
  if (fromNum > 0) {
    const [fv,] = await db
      .select()
      .from(schema.versions,)
      .where(and(eq(schema.versions.collectionId, collection.id,), eq(schema.versions.number, fromNum,),),)
      .limit(1,)

    if (fv) {
      fromVersion = fv
      fromRecords = await db
        .select()
        .from(schema.records,)
        .where(eq(schema.records.versionId, fv.id,),)
    }
  }

  const fromMap = new Map(fromRecords.map((r,) => [r.recordId, r,]),)
  const targetMap = new Map(targetRecords.map((r,) => [r.recordId, r,]),)

  const added = targetRecords.filter((r,) => !fromMap.has(r.recordId,))
  const removed = fromRecords.filter((r,) => !targetMap.has(r.recordId,))
  const updated = targetRecords.filter((r,) => {
    const prev = fromMap.get(r.recordId,)
    return prev && JSON.stringify(prev.data,) !== JSON.stringify(r.data,)
  },)

  // Compare schema sets
  const targetSchemas = await loadVersionSchemas(targetVersion.id,)
  const fromSchemas = fromVersion ? await loadVersionSchemas(fromVersion.id,) : []
  const targetSchemaMap = new Map(targetSchemas.map((e,) => [e.slug, e.schemaHash,]),)
  const fromSchemaMap = new Map(fromSchemas.map((e,) => [e.slug, e.schemaHash,]),)
  let schemaChanged = targetSchemaMap.size !== fromSchemaMap.size
  if (!schemaChanged) {
    for (const [s, hash,] of targetSchemaMap) {
      if (fromSchemaMap.get(s,) !== hash) {
        schemaChanged = true
        break
      }
    }
  }

  const readmeChanged = (targetVersion.readme ?? null) !== (fromVersion?.readme ?? null)

  // Compare file sets
  const targetFiles = await db
    .select({ hash: schema.versionFiles.fileHash, },)
    .from(schema.versionFiles,)
    .where(eq(schema.versionFiles.versionId, targetVersion.id,),)
  const fromFiles = fromVersion
    ? await db
      .select({ hash: schema.versionFiles.fileHash, },)
      .from(schema.versionFiles,)
      .where(eq(schema.versionFiles.versionId, fromVersion.id,),)
    : []
  const targetFileSet = new Set(targetFiles.map((f,) => f.hash),)
  const fromFileSet = new Set(fromFiles.map((f,) => f.hash),)
  const filesAdded = targetFiles.filter((f,) => !fromFileSet.has(f.hash,)).map((f,) => f.hash)
  const filesRemoved = fromFiles.filter((f,) => !targetFileSet.has(f.hash,)).map((f,) => f.hash)

  return c.json({
    from: fromNum,
    to: targetNum,
    added: added.map((r,) => ({ id: r.recordId, type: r.type, data: r.data, })),
    updated: updated.map((r,) => ({ id: r.recordId, type: r.type, data: r.data, })),
    removed: removed.map((r,) => r.recordId),
    meta: {
      schemaChanged,
      readmeChanged,
      readmeFrom: readmeChanged ? (fromVersion?.readme?.slice(0, 100,) ?? null) : undefined,
      readmeTo: readmeChanged ? (targetVersion.readme?.slice(0, 100,) ?? null) : undefined,
      filesAdded: filesAdded.length,
      filesRemoved: filesRemoved.length,
    },
  },)
}

async function resolveCollection(owner: string, slug: string,) {
  const [result,] = await db
    .select({
      id: schema.collections.id,
      accountId: schema.collections.accountId,
      slug: schema.collections.slug,
    },)
    .from(schema.collections,)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id,),)
    .where(and(eq(schema.accounts.slug, owner,), eq(schema.collections.slug, slug,),),)
    .limit(1,)
  return result ?? null
}

async function getCollectionArkInfo(
  collectionId: string,
): Promise<{ shoulder: string; arkId: string; naan: string } | null> {
  const [row,] = await db
    .select({
      shoulder: schema.arkShoulders.shoulder,
      arkId: schema.arkCollections.arkId,
      naan: schema.accounts.arkNaan,
    },)
    .from(schema.arkCollections,)
    .innerJoin(schema.collections, eq(schema.arkCollections.collectionId, schema.collections.id,),)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id,),)
    .innerJoin(schema.arkShoulders, eq(schema.arkShoulders.accountId, schema.accounts.id,),)
    .where(and(eq(schema.arkCollections.collectionId, collectionId,), eq(schema.arkCollections.enabled, true,),),)
    .limit(1,)
  if (!row) return null
  return { shoulder: row.shoulder, arkId: row.arkId, naan: row.naan ?? DEFAULT_NAAN, }
}
