import { and, desc, eq, ilike, inArray, ne, or } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, schema } from '../db/client.server.js'
import { buildSqliteBuffer, generateAllDDL, generateDDL } from '../lib/sqlite-gen.js'
import {
  filterRecordData,
  filterTypeSchema,
  getPrivateFields,
  getPrivateTypes,
  hasOrgAccess,
  parseSemver,
  type SchemaEntry,
} from '../lib/version-helpers.server.js'
import { type AuthEnv, fullPrincipalUserId } from './auth.server.js'

// In-memory LRU cache: key = `${collectionId}:${semver}`, value = { buffer, expiresAt }
const sqliteCache = new Map<
  string,
  {
    buffer: Buffer
    ddl: string
    ddlWithSamples: string
    sampleRows: Record<string, Record<string, unknown>>
    expiresAt: number
  }
>()
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const CACHE_MAX_ENTRIES = 10

// The SQLite build is proportional to collection size and holds the whole thing
// in memory, so it is offered only below this. Above it, the records API pages
// at any depth and Hot provides a SQL editor over a hydrated copy.
const MAX_QUERY_RECORDS = 250_000

// In-memory rate limit for the LLM endpoint (public path, spends CF AI credits)
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10 // requests per key per window
const rateBuckets = new Map<string, { count: number; resetAt: number }>()

/** Returns true if the request is within the rate limit */
function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  bucket.count++
  return bucket.count <= RATE_LIMIT_MAX
}

function cleanExpired() {
  const now = Date.now()
  for (const [key, entry] of sqliteCache) {
    if (entry.expiresAt < now) sqliteCache.delete(key)
  }
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt < now) rateBuckets.delete(key)
  }
}

function evictIfNeeded() {
  while (sqliteCache.size >= CACHE_MAX_ENTRIES) {
    // Evict oldest entry (first key in Map insertion order)
    const firstKey = sqliteCache.keys().next().value
    if (firstKey) sqliteCache.delete(firstKey)
    else break
  }
}

// Run cleanup every 5 minutes
setInterval(cleanExpired, 5 * 60 * 1000)

async function getOrBuildSqlite(
  owner: string,
  slug: string,
  versionSemver: string,
  userId: string | undefined,
  apiKeyCollectionIds?: string[],
) {
  const { semver: normalizedSemver } = parseSemver(versionSemver)

  // Resolve collection
  const [collection] = await db
    .select({
      id: schema.collections.id,
      organizationId: schema.collections.organizationId,
      public: schema.collections.public,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)

  if (!collection) return null

  // Access: private collections are only visible to org members; non-members of
  // public collections get a privacy-filtered build. A collection-scoped API
  // key (share/agent link) only counts for the collections it is scoped to.
  const keyScopeOk = !apiKeyCollectionIds || apiKeyCollectionIds.includes(collection.id)
  const ownerAccess = keyScopeOk && (await hasOrgAccess(userId, collection.organizationId))
  if (!collection.public && !ownerAccess) return null

  // Resolve version
  const [version] = await db
    .select({
      id: schema.versions.id,
      semver: schema.versions.semver,
      recordCount: schema.versions.recordCount,
    })
    .from(schema.versions)
    .where(
      and(
        eq(schema.versions.collectionId, collection.id),
        eq(schema.versions.semver, normalizedSemver),
        eq(schema.versions.status, 'ready'),
      ),
    )
    .limit(1)

  if (!version) return null

  // Building the SQLite artifact materializes every record body in memory. That
  // is fine for the collections this feature was built for and fatal on a
  // multi-million-record one: a 3.1M-record collection is several GB of jsonb
  // that would OOM the container — from an endpoint any visitor can reach.
  // Refuse above the threshold instead, and point at the paths that do scale.
  if (version.recordCount > MAX_QUERY_RECORDS) {
    return { tooLarge: true as const, recordCount: version.recordCount }
  }

  const cacheKey = `${collection.id}:${version.semver}:${ownerAccess ? 'full' : 'public'}`

  // Check cache (re-insert to move to end for LRU ordering)
  const cached = sqliteCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    sqliteCache.delete(cacheKey)
    cached.expiresAt = Date.now() + CACHE_TTL_MS
    sqliteCache.set(cacheKey, cached)
    return cached
  }

  // Load schemas for this version
  const versionSchemas = await db
    .select({ slug: schema.versionSchemas.slug, schema: schema.schemas.schema })
    .from(schema.versionSchemas)
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(eq(schema.versionSchemas.versionId, version.id))

  const schemaEntries = versionSchemas as SchemaEntry[]
  const privateTypes = ownerAccess ? new Set<string>() : getPrivateTypes(schemaEntries)

  const schemasMap: Record<string, any> = {}
  for (const vs of versionSchemas) {
    if (!ownerAccess) {
      if (privateTypes.has(vs.slug)) continue
      schemasMap[vs.slug] = filterTypeSchema(vs.schema as Record<string, unknown>)
    } else {
      schemasMap[vs.slug] = vs.schema
    }
  }

  // Load records (excluding private types and private records for non-owners).
  // Record-level privacy is the per-version version_records.private flag.
  const recordConditions = [eq(schema.versionRecords.versionId, version.id)]
  if (!ownerAccess) {
    recordConditions.push(eq(schema.versionRecords.private, false))
    for (const pt of privateTypes) {
      recordConditions.push(ne(schema.recordObjects.type, pt))
    }
  }
  let records = await db
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
    .where(and(...recordConditions))

  // Strip private fields for non-owners
  if (!ownerAccess) {
    const fieldCache = new Map<string, Set<string>>()
    records = records.map((rec) => {
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

  // Build SQLite
  const buffer = buildSqliteBuffer(schemasMap, records as any)
  const ddl = generateAllDDL(schemasMap)

  // Generate sample data (first row per table) for LLM context
  const sampleRows: Record<string, Record<string, unknown>> = {}
  for (const [typeName] of Object.entries(schemasMap)) {
    const firstRecord = records.find((r) => r.type === typeName)
    if (firstRecord && firstRecord.data && typeof firstRecord.data === 'object') {
      sampleRows[typeName] = firstRecord.data as Record<string, unknown>
    }
  }

  // Build DDL with inline sample rows (each sample right after its CREATE TABLE)
  const ddlWithSamples = Object.entries(schemasMap)
    .map(([name, s]) => {
      const tableDdl = generateDDL(name, s)
      const sample = sampleRows[name]
      if (sample) {
        return tableDdl + `\n-- Example row: ${JSON.stringify(sample)}`
      }
      return tableDdl
    })
    .join('\n\n')

  const entry = { buffer, ddl, ddlWithSamples, sampleRows, expiresAt: Date.now() + CACHE_TTL_MS }
  evictIfNeeded()
  sqliteCache.set(cacheKey, entry)
  return entry
}

/**
 * Shared 413 for collections above MAX_QUERY_RECORDS. Names the size, the limit
 * and what to use instead — a bare "too large" leaves the caller guessing
 * whether to retry.
 */
function tooLargeResponse(c: Context<AuthEnv>, recordCount: number) {
  return c.json(
    {
      error:
        `This collection has ${recordCount.toLocaleString()} records; the SQL explorer is ` +
        `available below ${MAX_QUERY_RECORDS.toLocaleString()}. It builds an in-memory SQLite ` +
        `copy of the whole version, which does not scale past that. Use the records API ` +
        `(GET /api/collections/:owner/:slug/versions/:n/records?after=…), which pages at any ` +
        `depth, or Hot for a SQL editor over a hydrated copy.`,
      recordCount,
      maxRecords: MAX_QUERY_RECORDS,
      statusCode: 413,
    },
    413,
  )
}

// GET /query/sqlite/:owner/:slug/:version — Download SQLite file for a version
export async function sqlite(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!
  const versionSemver = c.req.param('version')!
  const { semver } = parseSemver(versionSemver)

  const result = await getOrBuildSqlite(
    owner,
    slug,
    versionSemver,
    c.get('userId'),
    c.get('apiKeyCollectionIds'),
  )
  if (!result) return c.json({ error: 'Collection or version not found', statusCode: 404 }, 404)
  if ('tooLarge' in result) return tooLargeResponse(c, result.recordCount)

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/x-sqlite3',
      'Content-Disposition': `attachment; filename="${slug}-${semver}.sqlite"`,
      'Cache-Control': 'public, max-age=86400',
    },
  })
}

// GET /query/ddl/:owner/:slug/:version — Get DDL (schema only) for a version
export async function ddl(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!
  const versionSemver = c.req.param('version')!

  const result = await getOrBuildSqlite(
    owner,
    slug,
    versionSemver,
    c.get('userId'),
    c.get('apiKeyCollectionIds'),
  )
  if (!result) return c.json({ error: 'Collection or version not found', statusCode: 404 }, 404)
  if ('tooLarge' in result) return tooLargeResponse(c, result.recordCount)

  return c.json({ ddl: result.ddl })
}

// POST /query/generate-sql — LLM-powered SQL generation from natural language
export async function generateSql(c: Context<AuthEnv>) {
  // Public endpoint that spends Cloudflare AI credits — rate-limit per user/IP
  // Prefer cf-connecting-ip (unforgeable behind Cloudflare); the RIGHTMOST
  // X-Forwarded-For hop is the proxy-observed address, unlike the client-set
  // leftmost one.
  const xffParts =
    c.req
      .header('x-forwarded-for')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  const ip = c.req.header('cf-connecting-ip') ?? xffParts[xffParts.length - 1] ?? 'unknown'
  const rateKey = c.get('userId') ?? `ip:${ip}`
  if (!checkRateLimit(rateKey)) {
    return c.json({ error: 'Rate limit exceeded — try again in a minute', statusCode: 429 }, 429)
  }

  const { collections: collectionRefs, question } = await c.req.json()

  if (!collectionRefs?.length || !question) {
    return c.json({ error: 'collections and question are required', statusCode: 400 }, 400)
  }

  const cfAccountId = process.env.CF_ACCOUNT_ID
  const cfApiToken = process.env.CF_API_TOKEN

  if (!cfAccountId || !cfApiToken) {
    return c.json(
      {
        error: 'LLM not configured',
        message:
          'Set CF_ACCOUNT_ID and CF_API_TOKEN environment variables to enable natural language queries. You can still write SQL directly.',
      },
      503,
    )
  }

  // Build DDL with sample rows server-side
  let combinedDdl: string

  if (collectionRefs.length === 1) {
    const ref = collectionRefs[0]
    const result = await getOrBuildSqlite(
      ref.owner,
      ref.slug,
      ref.version,
      c.get('userId'),
      c.get('apiKeyCollectionIds'),
    )
    if (!result)
      return c.json(
        { error: `Collection ${ref.owner}/${ref.slug} v${ref.version} not found`, statusCode: 404 },
        404,
      )
    if ('tooLarge' in result) return tooLargeResponse(c, result.recordCount)
    combinedDdl = result.ddlWithSamples
    // Count records from cache (approximation from the version table already captured)
  } else {
    const parts: string[] = []
    for (const ref of collectionRefs) {
      const result = await getOrBuildSqlite(
        ref.owner,
        ref.slug,
        ref.version,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
      if (!result)
        return c.json(
          { error: `Collection ${ref.owner}/${ref.slug} v${ref.version} not found` },
          404,
        )
      if ('tooLarge' in result) return tooLargeResponse(c, result.recordCount)
      const prefix = ref.slug.replace(/-/g, '_')
      // Prefix table names and add _source column to DDL
      const ddlPrefixed = result.ddlWithSamples
        .replace(/CREATE TABLE "([^"]+)"/g, `CREATE TABLE "${prefix}__$1"`)
        .replace(/\);/g, `,\n  "_source" TEXT\n);`)
      parts.push(`-- Collection: ${ref.owner}/${ref.slug} v${ref.version}\n` + ddlPrefixed)
    }
    combinedDdl = parts.join('\n\n')
  }

  const isMultiCollection = collectionRefs.length > 1

  const systemPrompt = `You are a SQL assistant for SQLite databases. Given a schema and a user's question, produce a single SELECT query that answers it.

Respond in EXACTLY this format (two sections separated by the marker):

SQL:
<your SELECT query here>

REASONING:
<brief explanation of table/column choices, any assumptions made, and how you interpreted ambiguous terms>

Important rules:
- Examine the "Example row" comments in the schema — they show the ACTUAL data format stored in each column.${
    isMultiCollection
      ? `
- When multiple collections are loaded, consider ALL of them in your answer unless the question specifies otherwise.
- Every table has a "_source" column containing the collection identifier (e.g. "account/collection"). For row-level results, include _source as a column. For aggregations, include GROUP_CONCAT(DISTINCT _source) as _source so the user can see which collections contributed to the result.
- When counting across multiple tables, use UNION ALL to combine rows, not JOIN.`
      : ''
  }
- Only use JOIN when the question asks about relationships between tables.
- COUNT(*) counts rows.${
    isMultiCollection ? ' Use UNION ALL to combine rows from separate tables before counting.' : ''
  }
- When tables have a prefix like "collection__TableName", always use that full prefixed name.
- Do NOT include columns that don't exist in the schema.`

  const userPrompt = `Schema:\n${combinedDdl}\n\nQuestion: ${question}`

  console.info(`[generate-sql] question (${collectionRefs.length} collections): ${question}`)

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 800,
          temperature: 0,
        }),
      },
    )

    if (!response.ok) {
      const text = await response.text()
      console.error(`Cloudflare AI error: ${response.status} ${text}`)
      return c.json({ error: 'LLM request failed', rawResponse: text, statusCode: 502 }, 502)
    }

    const data = (await response.json()) as any
    let raw = data?.result?.response?.trim()

    if (!raw) {
      return c.json(
        { error: 'LLM returned empty response', rawResponse: JSON.stringify(data) },
        500,
      )
    }

    // Parse structured response
    let sql: string
    let reasoning: string | undefined

    const sqlMarker = raw.indexOf('SQL:')
    const reasoningMarker = raw.indexOf('REASONING:')

    if (sqlMarker !== -1 && reasoningMarker !== -1) {
      sql = raw
        .substring(sqlMarker + 4, reasoningMarker)
        .replace(/```sql\n?/g, '')
        .replace(/```/g, '')
        .trim()
      reasoning = raw.substring(reasoningMarker + 10).trim()
    } else {
      // Fallback: treat entire response as SQL
      sql = raw
        .replace(/```sql\n?/g, '')
        .replace(/```/g, '')
        .trim()
    }

    // Basic safety: only allow SELECT statements
    const normalized = sql.replace(/--.*$/gm, '').trim().toUpperCase()
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return c.json(
        {
          error: 'Generated query is not a SELECT statement',
          sql,
          reasoning,
          rawResponse: raw,
        },
        400,
      )
    }

    return c.json({ sql, reasoning })
  } catch (err: any) {
    console.error(`LLM generation error: ${err.message}`)
    return c.json({ error: 'Failed to generate SQL', statusCode: 500 }, 500)
  }
}

// GET /query/collections/search?q=term — Search collections (public + user's private)
export async function searchCollections(c: Context<AuthEnv>) {
  const q = c.req.query('q')
  if (!q || q.trim().length < 2) return c.json([])

  const term = `%${q.trim()}%`
  // A collection-scoped key must not surface the creator's private collections.
  const userId = fullPrincipalUserId(c)

  // Build accessible org IDs (user's own + orgs they belong to)
  let accessibleAccountIds: string[] = []
  if (userId) {
    const memberships = await db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, userId))
    accessibleAccountIds = [userId, ...memberships.map((m) => m.organizationId)]
  }

  // Query: public collections OR private collections owned by accessible orgs
  const searchCondition = or(
    ilike(schema.organization.slug, term),
    ilike(schema.collections.slug, term),
    ilike(schema.collections.name, term),
  )

  let whereCondition
  if (accessibleAccountIds.length > 0) {
    whereCondition = and(
      searchCondition,
      or(
        eq(schema.collections.public, true),
        inArray(schema.collections.organizationId, accessibleAccountIds),
      ),
    )
  } else {
    whereCondition = and(searchCondition, eq(schema.collections.public, true))
  }

  const collections = await db
    .select({
      ownerSlug: schema.organization.slug,
      slug: schema.collections.slug,
      name: schema.collections.name,
      public: schema.collections.public,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
    .where(whereCondition)
    .limit(20)

  // Get latest version + record count for each match
  const result = []
  for (const c2 of collections) {
    const [latestVersion] = await db
      .select({
        semver: schema.versions.semver,
        recordCount: schema.versions.recordCount,
      })
      .from(schema.versions)
      .innerJoin(schema.collections, eq(schema.collections.id, schema.versions.collectionId))
      .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
      .where(
        and(
          eq(schema.organization.slug, c2.ownerSlug),
          eq(schema.collections.slug, c2.slug),
          eq(schema.versions.status, 'ready'),
        ),
      )
      .orderBy(
        desc(schema.versions.major),
        desc(schema.versions.minor),
        desc(schema.versions.patch),
      )
      .limit(1)

    result.push({
      ownerSlug: c2.ownerSlug,
      slug: c2.slug,
      name: c2.name,
      public: c2.public,
      latestSemver: latestVersion?.semver ?? null,
      recordCount: latestVersion?.recordCount ?? 0,
    })
  }

  return c.json(result)
}

// GET /query/collections/:owner/:slug/versions — List versions for a collection
export async function collectionVersions(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!

  const versions = await db
    .select({
      semver: schema.versions.semver,
      recordCount: schema.versions.recordCount,
      createdAt: schema.versions.createdAt,
      message: schema.versions.message,
    })
    .from(schema.versions)
    .innerJoin(schema.collections, eq(schema.collections.id, schema.versions.collectionId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
    .where(
      and(
        eq(schema.organization.slug, owner),
        eq(schema.collections.slug, slug),
        eq(schema.collections.public, true),
        eq(schema.versions.status, 'ready'),
      ),
    )
    .orderBy(desc(schema.versions.major), desc(schema.versions.minor), desc(schema.versions.patch))

  if (versions.length === 0) {
    return c.json({ error: 'Collection not found or not public', statusCode: 404 }, 404)
  }

  return c.json(versions)
}
