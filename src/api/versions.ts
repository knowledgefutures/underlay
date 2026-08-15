import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { stream } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { buildArkUrl, DEFAULT_NAAN } from '../lib/ark.js'
import {
  canonicalize,
  deriveSemver,
  describeError,
  filterRecordData,
  filterSchemasForPublic,
  filterTypeSchema,
  getLatestReadyVersion,
  getPrivateFields,
  getPrivateTypes,
  hashSchema,
  hasOrgAccess,
  loadVersionSchemas,
  parseSemver,
  recordsVersionId,
  resolveAccessibleCollection,
  resolveCollection,
  type SchemaEntry,
  VersionHashStream,
} from '../lib/version-helpers.server.js'
import { dispatchDeliveries, enqueueWebhookDeliveries } from '../lib/webhooks.server.js'
import { type AuthEnv, requireAuth } from './auth.server.js'

const MAX_METADATA_BYTES = 64 * 1024

/**
 * Drop columns that are storage mechanics rather than part of the version a
 * caller sees.
 *
 * `recordsFromVersionId` is a LOCAL row id: it means nothing outside this
 * database, differs on every mirror of the same collection, and describes an
 * internal sharing optimization. The detail endpoints spread the whole version
 * row into their response, so without this it would become a field clients could
 * read and start depending on.
 */
function stripInternalVersionColumns(version: Record<string, any>): Record<string, any> {
  const out = { ...version }
  delete out.recordsFromVersionId
  return out
}

/**
 * Strip owner-only data from a version row before returning it to a non-owner:
 * private-type entries in `typeCounts` (which would disclose the existence and
 * exact size of private types) and the internal provenance fields.
 */
function sanitizeVersionForPublic(
  version: Record<string, any>,
  privateTypes: Set<string>,
): Record<string, any> {
  const out: Record<string, any> = { ...version }
  const tc = version.typeCounts as Record<string, number> | null | undefined
  if (tc) {
    out.typeCounts = Object.fromEntries(
      Object.entries(tc).filter(([type]) => !privateTypes.has(type)),
    )
  }
  delete out.pushedBy
  delete out.actorId
  delete out.signature
  return out
}

// Offset pagination is O(offset): Postgres must produce and discard every
// skipped row. Past a few thousand rows on a large version it exceeds the
// statement timeout. Reject deep offsets with a clear 400 and steer clients to
// keyset pagination (?after=<pagination.nextCursor>), which is an index seek and
// stays cheap at any depth. Matches Elasticsearch's default max_result_window.
const MAX_RECORDS_OFFSET = 10_000

// Per-request cap for the records query so a pathological scan surfaces as a
// clean 503 (with Retry-After) instead of hanging or returning an opaque 500.
const RECORDS_STATEMENT_TIMEOUT_MS = 10_000

// Delta and diff run three set operations per request, so they get more room
// than a single record page.
const DELTA_STATEMENT_TIMEOUT_MS = 30_000

// Enumeration caps. Fewer, larger pages is the single biggest lever on the
// wall-clock of a full-collection walk: an anonymous caller gets 60 requests a
// minute, an authenticated one 5,000, so a multi-million-record collection is
// bounded by request count long before it is bounded by bytes.
//
// Records carry bodies, so their cap is set by response size (2,000 × ~3 KB ≈
// 6 MB); manifest entries are ~120 bytes, so 100,000 is ~12 MB.
const MAX_RECORDS_LIMIT = 2_000
const MAX_MANIFEST_LIMIT = 100_000
const MAX_DIFF_LIMIT = 5_000

// Postgres SQLSTATE 57014 = query_canceled, raised when statement_timeout fires.
const isStatementTimeout = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === '57014'

/**
 * Run `fn` with a scoped statement timeout. SET LOCAL is reset when the
 * transaction ends, so this bounds one query rather than the connection.
 */
async function withStatementTimeout<T>(
  timeoutMs: number,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // The timeout value can't be a bind parameter, so it's inlined.
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(timeoutMs))}`)
    return fn(tx)
  })
}

/**
 * Keyset position within one of the delta/diff result lists:
 *   null            — not started, read from the beginning
 *   [id, hash]      — resume strictly after this row
 *   DONE            — this list is exhausted, skip its query entirely
 *
 * The three lists of a delta drain at different rates, so "exhausted" has to be
 * distinguishable from "not started". Collapsing them would restart a finished
 * list on the next page and loop forever.
 *
 * A version can legitimately hold two records with the same `record_id` and
 * different bodies — the manifest is deduplicated by hash, not by id — so the
 * key is (record_id, record_hash), which is unique per version and matches the
 * (version_id, record_id) index order.
 */
const DONE = 'done'
type ListCursor = [recordId: string, recordHash: string] | null | typeof DONE

/** Per-list cursors for the three delta lists, carried as one opaque token. */
interface DeltaCursor {
  added: ListCursor
  updated: ListCursor
  removed: ListCursor
}

const EMPTY_DELTA_CURSOR: DeltaCursor = { added: null, updated: null, removed: null }

const encodeDeltaCursor = (cursor: DeltaCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url')

/** Malformed cursors restart from the beginning rather than erroring. */
function decodeDeltaCursor(raw: string | undefined): DeltaCursor {
  if (!raw) return EMPTY_DELTA_CURSOR
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as DeltaCursor
    const list = (v: unknown): ListCursor => {
      if (v === DONE) return DONE
      return Array.isArray(v) &&
        v.length === 2 &&
        typeof v[0] === 'string' &&
        typeof v[1] === 'string'
        ? [v[0], v[1]]
        : null
    }
    return {
      added: list(parsed?.added),
      updated: list(parsed?.updated),
      removed: list(parsed?.removed),
    }
  } catch {
    return EMPTY_DELTA_CURSOR
  }
}

/** `WHERE (record_id, record_hash) > (…)` against the aliased version_records row. */
const afterCursor = (alias: string, cursor: ListCursor) =>
  Array.isArray(cursor)
    ? sql`AND (${sql.raw(alias)}.record_id, ${sql.raw(alias)}.record_hash) > (${cursor[0]}, ${cursor[1]})`
    : sql``

/** Split a limit+1 fetch into a page plus the cursor for the next one. */
function paginate<T extends { id: string; recordHash: string }>(
  rows: T[],
  limit: number,
): { page: Omit<T, 'recordHash'>[]; next: ListCursor; hasMore: boolean } {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return {
    page: page.map(({ recordHash: _recordHash, ...rest }) => rest),
    next: hasMore && last ? [last.id, last.recordHash] : DONE,
    hasMore,
  }
}

const app = new Hono<AuthEnv>()
  // A query cancelled by its scoped statement_timeout is a load signal, not a
  // server fault: answer 503 + Retry-After so a client backs off and retries
  // rather than treating it as a permanent failure.
  .use('*', async (c, next) => {
    try {
      await next()
    } catch (err) {
      if (!isStatementTimeout(err)) throw err
      c.header('Retry-After', '5')
      return c.json(
        {
          error:
            'Query timed out. Page large result sets with keyset pagination ' +
            '(?after= on records, ?cursor= on manifest and diff).',
          statusCode: 503,
        },
        503,
      )
    }
  })
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

      const collection = await resolveAccessibleCollection(
        owner,
        slug,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const ownerAccess = collection.ownerAccess
      const arkInfo = await getCollectionArkInfo(collection.id)

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

      // `actorId` is owner-only here, matching latest/:n (sanitizeVersionForPublic).
      // Without this the list endpoint leaked it while the detail endpoints hid it.
      return c.json(
        rows.map((row) => ({
          semver: row.semver,
          hash: ownerAccess ? row.hash : (row.publicHash ?? row.hash),
          message: row.message,
          appId: row.appId,
          ...(ownerAccess ? { actorId: row.actorId } : {}),
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
      const collection = await resolveAccessibleCollection(
        owner,
        slug,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const version = await getLatestReadyVersion(collection.id)

      if (!version) return c.json({ error: 'No versions', statusCode: 404 }, 404)

      const schemaEntries = await loadVersionSchemas(version.id)
      const ownerAccess = collection.ownerAccess
      const arkInfo = await getCollectionArkInfo(collection.id)

      const schemasMap = ownerAccess
        ? Object.fromEntries(schemaEntries.map((e) => [e.slug, e.schema]))
        : filterSchemasForPublic(schemaEntries)

      const versionView = stripInternalVersionColumns(
        ownerAccess ? version : sanitizeVersionForPublic(version, getPrivateTypes(schemaEntries)),
      )

      return c.json({
        ...versionView,
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
      const collection = await resolveAccessibleCollection(
        owner,
        slug,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
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
      const ownerAccess = collection.ownerAccess
      const arkInfo = await getCollectionArkInfo(collection.id)

      const schemasMap = ownerAccess
        ? Object.fromEntries(schemaEntries.map((e) => [e.slug, e.schema]))
        : filterSchemasForPublic(schemaEntries)

      const versionView = stripInternalVersionColumns(
        ownerAccess ? version : sanitizeVersionForPublic(version, getPrivateTypes(schemaEntries)),
      )

      return c.json({
        ...versionView,
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
      // `after` is the canonical keyset cursor; accept `cursor` as an alias so a
      // client that sends ?cursor= isn't silently reset to offset 0.
      const after = c.req.query('after') ?? c.req.query('cursor')

      const collection = await resolveAccessibleCollection(
        owner,
        slug,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
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

      // Filtering and ordering run entirely off version_records, which carries
      // denormalized record_id + type and is indexed on
      // (version_id, [type,] record_id). record_objects is joined only to
      // fetch bodies for the page that survives the index scan.
      const conditions = [eq(schema.versionRecords.versionId, recordsVersionId(version))]
      if (type) conditions.push(eq(schema.versionRecords.type, type))

      // Cursor-based pagination: ?after=recordId (keyset pagination)
      if (after) {
        conditions.push(sql`${schema.versionRecords.recordId} > ${after}`)
      }

      // Determine visibility
      const ownerAccess = collection.ownerAccess

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
            conditions.push(sql`${schema.versionRecords.type} != ${pt}`)
          }
        }
        // Exclude record-level private records (per-version flag).
        conditions.push(eq(schema.versionRecords.private, false))
      }

      const pageLimit = Math.min(parseInt(limit ?? '100', 10), MAX_RECORDS_LIMIT)

      // Resolve offset (ignored when a keyset cursor is supplied). Reject deep
      // offsets with a 400 rather than letting an O(offset) scan time out.
      let offsetValue = 0
      if (!after) {
        offsetValue = parseInt(offset ?? '0', 10)
        if (Number.isNaN(offsetValue) || offsetValue < 0) offsetValue = 0
        if (offsetValue > MAX_RECORDS_OFFSET) {
          return c.json(
            {
              error: `offset beyond ${MAX_RECORDS_OFFSET} is not supported; page deeper with keyset pagination using ?after=<pagination.nextCursor>`,
              statusCode: 400,
            },
            400,
          )
        }
      }

      let records: Array<{ id: string; type: string; data: unknown; hash: string }>
      try {
        records = await db.transaction(async (tx) => {
          // Scope a statement timeout to this query only; SET LOCAL is reset when
          // the transaction ends. Value can't be a bind param, so inline it.
          await tx.execute(
            sql`SET LOCAL statement_timeout = ${sql.raw(String(RECORDS_STATEMENT_TIMEOUT_MS))}`,
          )
          return tx
            .select({
              id: schema.versionRecords.recordId,
              type: schema.versionRecords.type,
              data: schema.recordObjects.data,
              // Non-owners see the public content-address (hash of the
              // private-field-stripped record they receive)
              hash: ownerAccess
                ? sql<string>`${schema.recordObjects.hash}`
                : sql<string>`coalesce(${schema.versionRecords.publicRecordHash}, ${schema.recordObjects.hash})`,
            })
            .from(schema.versionRecords)
            .innerJoin(
              schema.recordObjects,
              eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
            )
            .where(and(...conditions))
            .orderBy(schema.versionRecords.recordId)
            .limit(pageLimit + 1)
            .offset(after ? 0 : offsetValue)
        })
      } catch (err) {
        if (isStatementTimeout(err)) {
          c.header('Retry-After', '5')
          return c.json(
            {
              error:
                'Records query timed out. Use keyset pagination with ?after=<pagination.nextCursor> to page large result sets.',
              statusCode: 503,
            },
            503,
          )
        }
        throw err
      }

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
      const arkInfo = await getCollectionArkInfo(collection.id)
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
          total: await countVersionRecords(version, type, privateTypes),
        },
      })
    },
  )
  // Stream every record in a version as NDJSON, in one request
  .get(
    '/:owner/:slug/versions/:n/records.ndjson',
    openApi({
      tags: ['Versions'],
      summary: 'Stream all records in a version as NDJSON',
      description:
        'The bulk read path. Paging `/records` costs one round trip per page — 1,556 requests ' +
        'for a 3.1M-record collection — purely to re-establish a cursor the server just had. ' +
        'This streams the whole version in a single response, one JSON object per line, using a ' +
        'server-side cursor: memory is constant on both ends regardless of collection size. ' +
        'Records are ordered by id, and `?after=` resumes from the last id you saw, so a dropped ' +
        'connection costs the remainder rather than the whole read. Compare the line count ' +
        "against the version's `recordCount` to confirm you received all of it — a truncated " +
        'stream cannot be signalled in the status code, which is already sent.',
      request: { param: z.object({ owner: z.string(), slug: z.string(), n: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug, n } = c.req.valid('param')
      const type = c.req.query('type')
      const after = c.req.query('after')

      const collection = await resolveAccessibleCollection(
        owner,
        slug,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const { semver } = parseSemver(n)
      const [version] = await db
        .select({
          id: schema.versions.id,
          recordCount: schema.versions.recordCount,
          recordsFromVersionId: schema.versions.recordsFromVersionId,
        })
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

      const ownerAccess = collection.ownerAccess
      let privateTypes = new Set<string>()
      let schemaEntries: SchemaEntry[] = []
      if (!ownerAccess) {
        schemaEntries = await loadVersionSchemas(version.id)
        privateTypes = getPrivateTypes(schemaEntries)
        if (type && privateTypes.has(type)) {
          // Requesting a private type as a non-owner: an empty stream, not a 404,
          // so callers iterating types don't have to special-case it.
          c.header('Content-Type', 'application/x-ndjson')
          return stream(c, async () => {})
        }
      }

      // Private fields are resolved once per type rather than per record; at
      // millions of rows the difference is not marginal.
      const privateFieldsByType = new Map<string, Set<string>>()
      for (const entry of schemaEntries) {
        const fields = getPrivateFields(entry.schema)
        if (fields.size > 0) privateFieldsByType.set(entry.slug, fields)
      }

      const client = db.$client
      const privateTypeList = [...privateTypes]

      // The count a caller can actually verify against. `version.recordCount` is
      // the version's full total, so for a non-owner reading a collection with
      // private records or types the stream is legitimately shorter — and the
      // documented "count the lines, resume if they differ" check would never
      // terminate. Count what THIS caller will receive instead. One indexed
      // count is negligible next to streaming the rows.
      let streamedRecordCount = version.recordCount
      if (!ownerAccess || type) {
        const countConditions = [eq(schema.versionRecords.versionId, recordsVersionId(version))]
        if (type) countConditions.push(eq(schema.versionRecords.type, type))
        if (!ownerAccess) {
          countConditions.push(eq(schema.versionRecords.private, false))
          if (privateTypeList.length > 0) {
            countConditions.push(
              sql`${schema.versionRecords.type} <> ALL(${sql.param(privateTypeList)}::text[])`,
            )
          }
        }
        const [countRow] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.versionRecords)
          .where(and(...countConditions))
        streamedRecordCount = countRow?.n ?? 0
      }

      // Hono's compress() middleware deliberately skips this response: its
      // compressible-type list covers application/json and +json suffixes but
      // not application/x-ndjson, and it bails on anything already marked
      // Transfer-Encoding: chunked. Both are true here, so the route compresses
      // itself — this is the response that benefits most, at roughly 3x.
      const acceptsGzip = (c.req.header('Accept-Encoding') ?? '').includes('gzip')

      const encoder = new TextEncoder()

      // Read in keyset batches rather than one unbounded query.
      //
      // The obvious implementation — a single ORDER BY over the whole version,
      // read through a cursor — does NOT stream. Postgres has to satisfy the
      // sort before it can return the first row, and with no index supplying
      // that order it sorts every row externally: on a 3.1M-record version that
      // is ~3.5GB of temp files, ~46s before the first byte, and an ERROR 53100
      // when temp space runs out. A client-side cursor bounds the client's
      // memory, not the server's.
      //
      // Adding LIMIT changes the plan qualitatively. Bounded, Postgres walks
      // (version_id, record_id) in index order and finishes with an incremental
      // sort over each small group of equal record_ids — tens of kilobytes, in
      // memory, no temp files. So this issues many bounded queries instead of
      // one unbounded one: constant memory on both sides, first row in
      // milliseconds, nothing spilled to disk.
      const BATCH = 5_000
      // record_id is not unique within a version (a record can appear under more
      // than one hash), so the batch cursor is the (record_id, hash) pair.
      // Advancing on record_id alone would drop or repeat rows whenever a
      // duplicated id straddled a batch boundary.
      let lastId: string | null = null
      let lastHash: string | null = null

      // `pull` rather than a loop in `start`: the stream produces a batch only
      // when the consumer is ready for one, so a slow client throttles the reads
      // instead of letting them pile up in memory.
      const source = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            // The caller's `after` is an id: it resumes strictly past that id,
            // the same semantics the paged endpoint uses. Continuation between
            // batches is by the full pair, which is what keeps duplicate ids
            // intact.
            const keyset =
              lastId !== null
                ? client`AND (vr.record_id, vr.record_hash) > (${lastId}, ${lastHash})`
                : after
                  ? client`AND vr.record_id > ${after}`
                  : client``

            const rows = await client`
              SELECT vr.record_id AS id, vr.type, vr.record_hash AS record_hash,
                     ro.data,
                     ${ownerAccess ? client`ro.hash` : client`coalesce(vr.public_record_hash, ro.hash)`} AS hash
              FROM version_records vr
              INNER JOIN record_objects ro ON ro.hash = vr.record_hash
              WHERE vr.version_id = ${recordsVersionId(version)}
                ${type ? client`AND vr.type = ${type}` : client``}
                ${keyset}
                ${ownerAccess ? client`` : client`AND vr.private = false AND vr.type <> ALL(${privateTypeList}::text[])`}
              ORDER BY vr.record_id, vr.record_hash
              LIMIT ${BATCH}
            `

            if (rows.length === 0) {
              controller.close()
              return
            }

            let out = ''
            for (const row of rows) {
              const rowType = row['type'] as string
              const privateFields = ownerAccess ? undefined : privateFieldsByType.get(rowType)
              const data =
                privateFields && privateFields.size > 0
                  ? filterRecordData(row['data'], privateFields)
                  : row['data']
              out +=
                JSON.stringify({ id: row['id'], type: rowType, data, hash: row['hash'] }) + '\n'
            }
            const tail = rows[rows.length - 1]!
            lastId = tail['id'] as string
            lastHash = tail['record_hash'] as string
            // One enqueue per batch rather than per record: 3.1M individual
            // writes spends more time in the stream machinery than in the
            // database.
            controller.enqueue(encoder.encode(out))
            if (rows.length < BATCH) controller.close()
          } catch (err) {
            controller.error(err)
          }
        },
      })

      const headers: Record<string, string> = {
        'Content-Type': 'application/x-ndjson',
        // Lets a client verify completeness without a second request. This is the
        // count for THIS request (privacy-filtered, and `?type=`-scoped), so
        // comparing it against the lines received is an exact check for everyone.
        'X-Underlay-Record-Count': String(streamedRecordCount),
      }
      if (acceptsGzip) headers['Content-Encoding'] = 'gzip'

      // The DOM lib types CompressionStream's writable as BufferSource, which
      // does not unify with ReadableStream<Uint8Array>; the pairing is correct at
      // runtime.
      const gzip = new CompressionStream('gzip') as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >
      const responseBody: ReadableStream = acceptsGzip ? source.pipeThrough(gzip) : source

      return new Response(responseBody, { headers })
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
      const collection = await resolveAccessibleCollection(
        owner,
        slug,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
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

      const ownerAccess = collection.ownerAccess

      // For non-owners, private types/fields must not appear in the references,
      // and files reachable only through private content must not be listed.
      let privateTypes = new Set<string>()
      const privateFieldsByType = new Map<string, Set<string>>()
      if (!ownerAccess) {
        const schemaEntries = await loadVersionSchemas(version.id)
        privateTypes = getPrivateTypes(schemaEntries)
        for (const e of schemaEntries) privateFieldsByType.set(e.slug, getPrivateFields(e.schema))
      }

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

      // Only load records that contain $file references (DB-level filter).
      // Non-owners never see records flagged private.
      const refConditions = [
        eq(schema.versionRecords.versionId, recordsVersionId(version)),
        sql`${schema.recordObjects.data}::text LIKE '%"$file"%'`,
      ]
      if (!ownerAccess) refConditions.push(eq(schema.versionRecords.private, false))
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
        .where(and(...refConditions))

      const fileRefs = new Map<string, { recordId: string; type: string; field: string }[]>()
      for (const rec of fileRefRecords) {
        if (!ownerAccess && privateTypes.has(rec.type)) continue
        const privateFields = ownerAccess
          ? undefined
          : (privateFieldsByType.get(rec.type) ?? new Set<string>())
        const data = rec.data as Record<string, unknown>
        for (const [field, val] of Object.entries(data)) {
          if (privateFields?.has(field)) continue
          if (val && typeof val === 'object' && '$file' in (val as any)) {
            const hash = ((val as any).$file as string).replace('sha256:', '')
            if (!fileRefs.has(hash)) fileRefs.set(hash, [])
            fileRefs.get(hash)!.push({ recordId: rec.recordId, type: rec.type, field })
          }
        }
      }

      // Non-owners only see files still reachable through a non-private reference.
      const visibleFileRows = ownerAccess ? fileRows : fileRows.filter((f) => fileRefs.has(f.hash))

      return c.json(
        visibleFileRows.map((f) => ({
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
      const collection = await resolveAccessibleCollection(
        owner,
        slug,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
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

      const limit = Math.min(parseInt(c.req.query('limit') ?? '10000', 10), MAX_MANIFEST_LIMIT)
      const cursor = c.req.query('cursor')

      const fileHashes = await db
        .select({ hash: schema.versionFiles.fileHash })
        .from(schema.versionFiles)
        .where(eq(schema.versionFiles.versionId, version.id))

      const schemaEntries = await loadVersionSchemas(version.id)

      // Privacy filtering for non-owners: hide private types and private records.
      // Records whose type has private *fields* are listed under their public
      // content-address (hash of the filtered record), so readers can verify
      // what they actually receive.
      //
      // Record-level privacy is the per-version `version_records.private` flag and
      // type/id/public-hash are all on version_records too, so these queries never
      // join record_objects at all.
      const ownerAccess = collection.ownerAccess
      const privateTypes = ownerAccess ? new Set<string>() : getPrivateTypes(schemaEntries)
      // `NOT IN (${array})` must NOT be used here: drizzle renders an embedded
      // array as a row constructor — `NOT IN (($1,$2))` — which Postgres rejects
      // with `operator does not exist: text <> record`. Use `<> ALL(array)`.
      const typeExclusion = (types: Set<string>) =>
        types.size > 0 ? sql`AND vr.type <> ALL(${sql.param([...types])}::text[])` : sql``
      const privacyWhere = ownerAccess
        ? sql``
        : sql`AND vr.private = false ${typeExclusion(privateTypes)}`
      const servedHash = ownerAccess
        ? sql`vr.record_hash`
        : sql`coalesce(vr.public_record_hash, vr.record_hash)`
      const manifestHash = ownerAccess ? version.hash : (version.publicHash ?? version.hash)
      const schemasOut = ownerAccess
        ? Object.fromEntries(schemaEntries.map((e) => [e.slug, e.schemaHash]))
        : Object.fromEntries(
            schemaEntries
              .filter((e) => !privateTypes.has(e.slug))
              .map((e) => [e.slug, hashSchema(filterTypeSchema(e.schema))]),
          )

      // Delta manifest. The three set operations run as anti-/semi-joins between
      // two versions over (version_id, record_id) — no correlated lookup through
      // record_objects, and each list is keyset-paginated so a delta of any size
      // can be walked to completion.
      if (sinceParam) {
        const { semver: sinceSemver } = parseSemver(sinceParam)

        const [sinceVersion] = await db
          .select({
            id: schema.versions.id,
            recordsFromVersionId: schema.versions.recordsFromVersionId,
          })
          .from(schema.versions)
          .where(
            and(
              eq(schema.versions.collectionId, collection.id),
              eq(schema.versions.semver, sinceSemver),
              eq(schema.versions.status, 'ready'),
            ),
          )
          .limit(1)

        if (!sinceVersion)
          return c.json({ error: `Version ${sinceSemver} not found`, statusCode: 404 }, 404)

        // Record-set ids for the delta queries. `sinceId` stays the real version
        // id because it also loads `version_schemas`, which a metadata patch owns
        // outright — only the `version_records` side resolves through the pointer.
        const targetId = recordsVersionId(version)
        const sinceId = sinceVersion.id
        const sinceRecordsId = recordsVersionId(sinceVersion)
        const at = decodeDeltaCursor(cursor)

        type DeltaRow = { id: string; type: string; hash: string; recordHash: string }
        type UpdatedRow = DeltaRow & { previousHash: string | null }

        // The `removed` list iterates the `since` version and `previousHash`
        // reads the since record, so both must judge privacy against the SINCE
        // version's own private-type set (which can differ from the target's).
        const sincePrivateTypes = ownerAccess
          ? new Set<string>()
          : getPrivateTypes(await loadVersionSchemas(sinceId))

        // Non-owners get the previous version's PUBLIC served hash, and only when
        // that prior record was itself public — otherwise `previousHash` is NULL.
        // Never serve `s.record_hash` for a private prior record; that would leak
        // the private content's digest.
        const sinceTypeGuard =
          sincePrivateTypes.size > 0
            ? sql`AND s.type <> ALL(${sql.param([...sincePrivateTypes])}::text[])`
            : sql``
        const previousServedHash = ownerAccess
          ? sql`(SELECT s.record_hash FROM version_records s
                 WHERE s.version_id = ${sinceRecordsId} AND s.record_id = vr.record_id LIMIT 1)`
          : sql`(SELECT CASE WHEN s.private = false ${sinceTypeGuard}
                            THEN coalesce(s.public_record_hash, s.record_hash) END
                 FROM version_records s
                 WHERE s.version_id = ${sinceRecordsId} AND s.record_id = vr.record_id LIMIT 1)`

        // Visibility of a row for the CALLER, evaluated against the version that
        // row belongs to (private-type sets differ between versions). Applied to
        // BOTH the iterated rows and the presence subquery, so that a record
        // whose privacy flipped with unchanged content still shows up: becoming
        // private reads as `removed`, becoming public reads as `added`. Without
        // it such a record is in neither list and delta-following mirrors keep
        // serving content the full manifest no longer includes.
        const visible = (alias: string, types: Set<string>) =>
          ownerAccess
            ? sql``
            : types.size > 0
              ? sql`AND ${sql.raw(alias)}.private = false AND ${sql.raw(alias)}.type <> ALL(${sql.param([...types])}::text[])`
              : sql`AND ${sql.raw(alias)}.private = false`

        const deltaQuery = (
          selfId: number,
          selfTypes: Set<string>,
          otherId: number,
          otherTypes: Set<string>,
          presence: 'absent' | 'changed',
          cursor: ListCursor,
          extraColumn = sql``,
        ) => sql`
          SELECT vr.record_id AS id, vr.type, ${servedHash} AS hash,
                 vr.record_hash AS "recordHash"${extraColumn}
          FROM version_records vr
          WHERE vr.version_id = ${selfId}
            ${
              presence === 'absent'
                ? sql`AND NOT EXISTS (
                    SELECT 1 FROM version_records s
                    WHERE s.version_id = ${otherId} AND s.record_id = vr.record_id
                      ${visible('s', otherTypes)}
                  )`
                : sql`AND EXISTS (
                    SELECT 1 FROM version_records s
                    WHERE s.version_id = ${otherId} AND s.record_id = vr.record_id
                      AND s.record_hash <> vr.record_hash
                      ${visible('s', otherTypes)}
                  )`
            }
            ${visible('vr', selfTypes)} ${afterCursor('vr', cursor)}
          ORDER BY vr.record_id, vr.record_hash
          LIMIT ${limit + 1}
        `

        const [addedRows, removedRows, updatedRows] = await withStatementTimeout(
          DELTA_STATEMENT_TIMEOUT_MS,
          async (tx) => {
            // A list the caller has already drained is skipped, not re-run.
            const run = <T>(cursor: ListCursor, query: ReturnType<typeof sql>) =>
              cursor === DONE
                ? Promise.resolve([] as T[])
                : (tx.execute(query) as unknown as Promise<T[]>)
            return Promise.all([
              run<DeltaRow>(
                at.added,
                deltaQuery(
                  targetId,
                  privateTypes,
                  sinceRecordsId,
                  sincePrivateTypes,
                  'absent',
                  at.added,
                ),
              ),
              run<DeltaRow>(
                at.removed,
                deltaQuery(
                  sinceRecordsId,
                  sincePrivateTypes,
                  targetId,
                  privateTypes,
                  'absent',
                  at.removed,
                ),
              ),
              run<UpdatedRow>(
                at.updated,
                deltaQuery(
                  targetId,
                  privateTypes,
                  sinceRecordsId,
                  sincePrivateTypes,
                  'changed',
                  at.updated,
                  sql`, ${previousServedHash} AS "previousHash"`,
                ),
              ),
            ])
          },
        )

        const added = paginate(addedRows, limit)
        const removed = paginate(removedRows, limit)
        const updated = paginate(updatedRows, limit)

        const hasMore = added.hasMore || removed.hasMore || updated.hasMore
        const nextCursor = hasMore
          ? encodeDeltaCursor({
              added: at.added === DONE ? DONE : added.next,
              updated: at.updated === DONE ? DONE : updated.next,
              removed: at.removed === DONE ? DONE : removed.next,
            })
          : null

        return c.json({
          semver: version.semver,
          hash: manifestHash,
          since: sinceSemver,
          schemas: schemasOut,
          delta: { added: added.page, updated: updated.page, removed: removed.page },
          files: fileHashes.map((f) => f.hash),
          pagination: { limit, hasMore, nextCursor },
          // Retained for clients written against the pre-cursor response, which
          // treat a capped delta as "give up and rebuild". They still can; a
          // client that understands `pagination.nextCursor` should page instead.
          truncated: hasMore,
        })
      }

      // Full manifest, keyset-paginated on (record_id, record_hash) — the
      // (version_id, record_id) index order. Previously ordered by the served
      // hash, which for public readers is a coalesce() expression and therefore
      // an unindexed sort of the whole version.
      const at = decodeDeltaCursor(cursor)
      // `private` is echoed back so a manifest round-trip is lossless. Privacy is
      // authored per push and omitting it on a re-push means PUBLIC, so a client
      // that reads a manifest, edits it and pushes it back would silently
      // de-privatize every record if it could not read the flag. Only `true` is
      // emitted (a non-owner's rows are all public, so they see none).
      const recordRows = (await withStatementTimeout(DELTA_STATEMENT_TIMEOUT_MS, async (tx) =>
        tx.execute(sql`
            SELECT vr.record_id AS id, vr.type, ${servedHash} AS hash,
                   vr.record_hash AS "recordHash", vr.private
            FROM version_records vr
            WHERE vr.version_id = ${recordsVersionId(version)}
              ${privacyWhere} ${afterCursor('vr', at.added)}
            ORDER BY vr.record_id, vr.record_hash
            LIMIT ${limit + 1}
          `),
      )) as unknown as {
        id: string
        type: string
        hash: string
        recordHash: string
        private: boolean
      }[]

      const { page, next, hasMore } = paginate(recordRows, limit)
      const records = page.map(({ private: isPrivate, ...rest }) =>
        isPrivate ? { ...rest, private: true } : rest,
      )

      return c.json({
        semver: version.semver,
        hash: manifestHash,
        schemas: schemasOut,
        records,
        files: fileHashes.map((f) => f.hash),
        pagination: {
          limit,
          hasMore,
          nextCursor: hasMore ? encodeDeltaCursor({ ...EMPTY_DELTA_CURSOR, added: next }) : null,
        },
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
      const diffLimit = Math.min(parseInt(c.req.query('limit') ?? '500', 10), MAX_DIFF_LIMIT)
      const diffCursor = decodeDeltaCursor(c.req.query('cursor'))

      const collection = await resolveAccessibleCollection(
        owner,
        slug,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
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

      const targetId = recordsVersionId(targetVersion)
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
      // As in the delta path: `fromId` loads schemas, `fromRecordsId` reads
      // `version_records`. They differ only when `from` is a metadata patch.
      const fromRecordsId = fromVersion ? recordsVersionId(fromVersion) : undefined

      // Privacy filtering for non-owners: hide private types and private records.
      // record_objects is joined only for the record body (ro.data); record-level
      // privacy is the per-version `version_records.private` flag.
      const targetSchemas = await loadVersionSchemas(targetVersion.id)
      const ownerAccess = collection.ownerAccess
      const privateTypes = ownerAccess ? new Set<string>() : getPrivateTypes(targetSchemas)
      const fromPrivateTypes =
        ownerAccess || !fromId
          ? new Set<string>()
          : getPrivateTypes(await loadVersionSchemas(fromId))

      // Caller-visibility of a row, judged against its OWN version's private-type
      // set. Applied to the iterated rows and to the presence subquery alike, so a
      // record whose privacy flipped with unchanged content is reported (redacted
      // ⇒ `removed`, un-redacted ⇒ `added`) instead of vanishing from the diff.
      // `<> ALL(array)`, never `NOT IN (${array})` — drizzle renders an embedded
      // array as a row constructor, which Postgres rejects.
      const visible = (alias: string, types: Set<string>) =>
        ownerAccess
          ? sql``
          : types.size > 0
            ? sql`AND ${sql.raw(alias)}.private = false AND ${sql.raw(alias)}.type <> ALL(${sql.param([...types])}::text[])`
            : sql`AND ${sql.raw(alias)}.private = false`

      type DiffRow = { id: string; type: string; data: unknown; recordHash: string }

      /** One side of the diff: rows of `selfId` absent from / changed in `otherId`. */
      const diffQuery = (
        selfId: number,
        selfTypes: Set<string>,
        otherId: number | undefined,
        otherTypes: Set<string>,
        mode: 'absent' | 'changed' | 'all',
        cursor: ListCursor,
      ) => sql`
        SELECT vr.record_id AS id, vr.type, ro.data, vr.record_hash AS "recordHash"
        FROM version_records vr
        INNER JOIN record_objects ro ON ro.hash = vr.record_hash
        WHERE vr.version_id = ${selfId}
          ${
            mode === 'absent'
              ? sql`AND NOT EXISTS (
                  SELECT 1 FROM version_records s
                  WHERE s.version_id = ${otherId!} AND s.record_id = vr.record_id
                    ${visible('s', otherTypes)}
                )`
              : mode === 'changed'
                ? sql`AND EXISTS (
                  SELECT 1 FROM version_records s
                  WHERE s.version_id = ${otherId!} AND s.record_id = vr.record_id
                    AND s.record_hash <> vr.record_hash
                    ${visible('s', otherTypes)}
                )`
                : sql``
          }
          ${visible('vr', selfTypes)} ${afterCursor('vr', cursor)}
        ORDER BY vr.record_id, vr.record_hash
        LIMIT ${diffLimit + 1}
      `

      const [addedRows, removedRows, updatedRows] = await withStatementTimeout(
        DELTA_STATEMENT_TIMEOUT_MS,
        async (tx) => {
          // Skip lists the caller has already drained, and — with no ?from= —
          // the two that don't apply.
          const run = (cursor: ListCursor, query: ReturnType<typeof sql> | null) =>
            cursor === DONE || !query
              ? Promise.resolve([] as DiffRow[])
              : (tx.execute(query) as unknown as Promise<DiffRow[]>)
          return Promise.all([
            run(
              diffCursor.added,
              diffQuery(
                targetId,
                privateTypes,
                fromRecordsId,
                fromPrivateTypes,
                fromRecordsId ? 'absent' : 'all',
                diffCursor.added,
              ),
            ),
            run(
              diffCursor.removed,
              fromRecordsId
                ? diffQuery(
                    fromRecordsId,
                    fromPrivateTypes,
                    targetId,
                    privateTypes,
                    'absent',
                    diffCursor.removed,
                  )
                : null,
            ),
            run(
              diffCursor.updated,
              fromRecordsId
                ? diffQuery(
                    targetId,
                    privateTypes,
                    fromRecordsId,
                    fromPrivateTypes,
                    'changed',
                    diffCursor.updated,
                  )
                : null,
            ),
          ])
        },
      )

      const added = paginate(addedRows, diffLimit)
      const removed = paginate(removedRows, diffLimit)
      const updated = paginate(updatedRows, diffLimit)

      // Compare schema sets
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

      // Strip private fields from record data if not owner
      const fieldCache = new Map<string, Set<string>>()
      const stripPrivateFields = (r: { id: string; type: string; data: unknown }) => {
        if (ownerAccess) return { id: r.id, type: r.type, data: r.data }
        if (!fieldCache.has(r.type)) {
          const entry = targetSchemas.find((e) => e.slug === r.type)
          fieldCache.set(r.type, entry ? getPrivateFields(entry.schema) : new Set())
        }
        const privateFields = fieldCache.get(r.type)!
        return {
          id: r.id,
          type: r.type,
          data: privateFields.size > 0 ? filterRecordData(r.data, privateFields) : r.data,
        }
      }

      const hasMore = added.hasMore || removed.hasMore || updated.hasMore

      return c.json({
        from: fromVersion?.semver ?? null,
        to: targetVersion.semver,
        added: added.page.map(stripPrivateFields),
        updated: updated.page.map(stripPrivateFields),
        removed: removed.page.map((r) => r.id),
        pagination: {
          limit: diffLimit,
          hasMore,
          nextCursor: hasMore
            ? encodeDeltaCursor({
                added: diffCursor.added === DONE ? DONE : added.next,
                updated: diffCursor.updated === DONE ? DONE : updated.next,
                removed: diffCursor.removed === DONE ? DONE : removed.next,
              })
            : null,
        },
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
      description:
        'Creates a patch version carrying the merged metadata. Building it means folding both ' +
        'version digests over the record set and copying every `version_records` row, which on a ' +
        'multi-million-record collection takes longer than an HTTP request survives. Pass ' +
        '`?async=true` to get a `202` with a `job_id` and poll ' +
        '`GET /:owner/:slug/metadata/jobs/:jobId` for the outcome.',
      request: {
        param: z.object({ owner: z.string(), slug: z.string() }),
        // Metadata is a free-form JSON object (readme, description, license, ...)
        json: z.record(z.string(), z.unknown()),
      },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const body = c.req.valid('json')

      // Query param only, unlike the negotiate commit which also accepts
      // `{async: true}` in the body. Here the body *is* the metadata, so an
      // `async` key in it would be merged into the stored metadata and persisted.
      const asyncQuery = c.req.query('async')
      const wantsAsync = asyncQuery === 'true' || asyncQuery === '1'

      // Metadata is hashed and stored on every version row — keep it bounded
      if (JSON.stringify(body).length > MAX_METADATA_BYTES) {
        return c.json(
          {
            error: `Metadata exceeds maximum size of ${MAX_METADATA_BYTES} bytes`,
            statusCode: 413,
          },
          413,
        )
      }

      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      const userId = c.get('userId')
      if (!(await hasOrgAccess(userId, collection.organizationId))) {
        return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
      }

      const scopedCollections = c.get('apiKeyCollectionIds')
      if (scopedCollections && !scopedCollections.includes(collection.id)) {
        return c.json({ error: 'API key is not scoped to this collection', statusCode: 403 }, 403)
      }

      const latest = await getLatestReadyVersion(collection.id)

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

      // Two writers both reading `latest` would derive the same patch semver and
      // one would lose to the (collection_id, semver) unique constraint after
      // doing all the work. Refuse up front instead — and refuse for the
      // synchronous path too, since a sync PATCH races a running job just as
      // badly.
      const [inFlight] = await db
        .select({ id: schema.metadataJobs.id })
        .from(schema.metadataJobs)
        .where(
          and(
            eq(schema.metadataJobs.collectionId, collection.id),
            eq(schema.metadataJobs.status, 'running'),
          ),
        )
        .limit(1)
      if (inFlight) {
        return c.json(
          {
            error: 'A metadata update is already in progress for this collection',
            statusCode: 409,
            job_id: inFlight.id,
          },
          409,
        )
      }

      const buildVersion = async (): Promise<{
        status: ContentfulStatusCode
        body: Record<string, unknown>
      }> => {
        const schemaEntries = await loadVersionSchemas(latest.id)
        const schemaSet = schemaEntries.map((e) => ({ slug: e.slug, schemaHash: e.schemaHash }))
        // Hash-only load: public hashes were computed and stored at commit time,
        // so a metadata-only version never needs the record bodies
        const fileHashes = (
          await db
            .select({ hash: schema.versionFiles.fileHash })
            .from(schema.versionFiles)
            .where(eq(schema.versionFiles.versionId, latest.id))
        ).map((f) => f.hash)

        const privateTypes = getPrivateTypes(schemaEntries)
        const publicSchemaSet = schemaEntries
          .filter((e) => !privateTypes.has(e.slug))
          .map((e) => ({ slug: e.slug, schemaHash: hashSchema(filterTypeSchema(e.schema)) }))

        // Both digests are folded over hashes streamed from Postgres in sorted
        // order, exactly as the commit path does. Loading every row to build two
        // in-memory arrays made a metadata edit cost as much as a full push — on a
        // multi-million-record collection, several hundred MB of JS objects to
        // change a description.
        //
        // COLLATE "C" is required: the digest must see byte order, which is what
        // Array.prototype.sort() produces, not the database's locale collation.
        const client = db.$client
        const CURSOR_CHUNK = 10_000

        const versionHashStream = new VersionHashStream(schemaSet, fileHashes, newMetadata)
        await client`
        SELECT record_hash AS h FROM version_records
        WHERE version_id = ${recordsVersionId(latest)}
        ORDER BY record_hash COLLATE "C"
      `.cursor(CURSOR_CHUNK, (rows) => {
          for (const row of rows) versionHashStream.push(row['h'] as string)
        })
        const versionHash = versionHashStream.digest()

        const publicHashStream = new VersionHashStream(publicSchemaSet, fileHashes, newMetadata)
        await client`
        SELECT coalesce(vr.public_record_hash, vr.record_hash) AS h
        FROM version_records vr
        WHERE vr.version_id = ${recordsVersionId(latest)}
          AND NOT vr.private
          AND vr.type <> ALL(${[...privateTypes]}::text[])
        ORDER BY coalesce(vr.public_record_hash, vr.record_hash) COLLATE "C"
      `.cursor(CURSOR_CHUNK, (rows) => {
          for (const row of rows) publicHashStream.push(row['h'] as string)
        })
        const publicHash = publicHashStream.digest().replace('private:', 'public:')

        const sv = deriveSemver(latest.semver, false, false, true)

        let newVersionId: number | undefined
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
              // Same record set as the base version, so the per-type counts carry
              // over unchanged.
              typeCounts: latest.typeCounts,
              totalBytes: latest.totalBytes,
              // Share the base's record set rather than copying it. Points at the
              // version that actually owns the rows: if the base is itself a
              // metadata patch, inherit its pointer so this stays one hop.
              recordsFromVersionId: recordsVersionId(latest),
            })
            .returning({ id: schema.versions.id })

          newVersionId = version!.id

          if (schemaEntries.length > 0) {
            await tx.insert(schema.versionSchemas).values(
              schemaEntries.map((e) => ({
                versionId: version!.id,
                slug: e.slug,
                schemaId: e.schemaId,
              })),
            )
          }

          // No record-set copy: `recordsFromVersionId` above points at the base's
          // rows. The schema set is unchanged, so every column that copy used to
          // carry — the public content-addresses and the per-version `private`
          // flag included — is now read from the base directly, which cannot
          // drift from it by construction.

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

        // Fire webhooks for the metadata (patch) version — best-effort.
        try {
          const deliveryIds = await enqueueWebhookDeliveries(
            {
              id: newVersionId!,
              semver: sv.semver,
              hash: versionHash,
              major: sv.major,
              minor: sv.minor,
              patch: sv.patch,
              recordCount: latest.recordCount,
              fileCount: latest.fileCount,
            },
            'patch',
            collection.id,
          )
          dispatchDeliveries(deliveryIds)
        } catch (err) {
          console.error(`[webhooks] failed to enqueue for ${sv.semver}:`, err)
        }

        return {
          status: 201,
          body: { semver: sv.semver, hash: versionHash, metadata: newMetadata },
        }
      }

      // Synchronous by default: the CLI, existing scripts and every caller
      // written before `?async=true` expect the version in the response, and on
      // an ordinary collection the whole thing takes well under a second.
      if (!wantsAsync) {
        const { status, body } = await buildVersion()
        return c.json(body, status)
      }

      const [job] = await db
        .insert(schema.metadataJobs)
        .values({
          collectionId: collection.id,
          userId: userId ?? null,
          baseSemver: latest.semver,
          metadata: newMetadata,
        })
        .returning({ id: schema.metadataJobs.id })

      // Deliberately not awaited: the response goes out now and the outcome is
      // recorded on the job for the client to poll. A process that dies mid-build
      // rolls the version transaction back and leaves the job 'running', which
      // the cleanup sweep fails out.
      void (async () => {
        const startedAt = Date.now()
        try {
          const { status, body } = await buildVersion()
          const ok = status >= 200 && status < 300
          await db
            .update(schema.metadataJobs)
            .set({
              status: ok ? 'completed' : 'failed',
              ...(ok ? { result: body as never } : { error: body as never }),
              finishedAt: new Date(),
            })
            .where(eq(schema.metadataJobs.id, job!.id))
          console.log(
            `[metadata] async job ${job!.id} ${ok ? `created ${body['semver']}` : `failed (${status})`} in ${Math.round((Date.now() - startedAt) / 1000)}s`,
          )
        } catch (err) {
          console.error(`[metadata] async job ${job!.id} threw: ${describeError(err)}`, err)
          await db
            .update(schema.metadataJobs)
            .set({
              status: 'failed',
              error: { statusCode: 500, error: describeError(err) },
              finishedAt: new Date(),
            })
            .where(eq(schema.metadataJobs.id, job!.id))
            .catch(() => {})
        }
      })()

      return c.json({ job_id: job!.id, status: 'running', base_semver: latest.semver }, 202)
    },
  )
  // Poll an async metadata job started with `PATCH …/metadata?async=true`
  .get(
    '/:owner/:slug/metadata/jobs/:jobId',
    requireAuth('read'),
    openApi({
      tags: ['Versions'],
      summary: 'Get the status of an async metadata update',
      description:
        '`status` is one of `running`, `completed` or `failed`. `result` holds the created ' +
        'version once status is `completed`, and `error` the rejection body once it is `failed`.',
      request: {
        param: z.object({ owner: z.string(), slug: z.string(), jobId: z.string() }),
      },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug, jobId } = c.req.valid('param')

      const collection = await resolveCollection(owner, slug)
      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      // Authorized by collection access rather than by who started the job: a
      // job is a property of the collection, and anyone who could write the
      // metadata can see how the write went.
      const userId = c.get('userId')
      if (!(await hasOrgAccess(userId, collection.organizationId))) {
        return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
      }

      const scopedCollections = c.get('apiKeyCollectionIds')
      if (scopedCollections && !scopedCollections.includes(collection.id)) {
        return c.json({ error: 'API key is not scoped to this collection', statusCode: 403 }, 403)
      }

      const [job] = await db
        .select()
        .from(schema.metadataJobs)
        .where(
          and(
            eq(schema.metadataJobs.id, jobId),
            eq(schema.metadataJobs.collectionId, collection.id),
          ),
        )
        .limit(1)

      if (!job) return c.json({ error: 'Job not found', statusCode: 404 }, 404)

      return c.json({
        job_id: job.id,
        status: job.status,
        base_semver: job.baseSemver,
        started_at: job.startedAt,
        finished_at: job.finishedAt,
        result: job.result ?? null,
        error: job.error ?? null,
      })
    },
  )

/**
 * Total records in a version under the caller's visibility and an optional
 * `?type=` filter. Reads the per-type counts stored on the version row at
 * commit; falls back to a COUNT(*) over the (version_id, type, record_id) index
 * for versions written before that column existed.
 *
 * Row-level private records are not represented in `type_counts`, so on a
 * collection that uses them this is an upper bound for non-owners rather than
 * an exact count. It was previously the whole version's `recordCount`
 * regardless of the filter, which was simply wrong under `?type=`.
 */
async function countVersionRecords(
  version: {
    id: number
    recordCount: number
    typeCounts: Record<string, number> | null
    recordsFromVersionId: number | null
  },
  type: string | undefined,
  privateTypes: Set<string>,
): Promise<number> {
  const counts = version.typeCounts
  if (counts) {
    if (type) return counts[type] ?? 0
    let total = 0
    for (const [slug, n] of Object.entries(counts)) {
      if (!privateTypes.has(slug)) total += n
    }
    return total
  }

  if (!type && privateTypes.size === 0) return version.recordCount

  const conditions = [eq(schema.versionRecords.versionId, recordsVersionId(version))]
  if (type) conditions.push(eq(schema.versionRecords.type, type))
  for (const pt of privateTypes) conditions.push(sql`${schema.versionRecords.type} != ${pt}`)
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.versionRecords)
    .where(and(...conditions))
  return row?.n ?? 0
}

/** ARK info is decorative on these endpoints — failures are logged, not fatal */
async function getCollectionArkInfo(
  collectionId: string,
): Promise<{ shoulder: string; arkId: string; naan: string } | null> {
  try {
    const [row] = await db
      .select({
        shoulder: schema.arkShoulders.shoulder,
        arkId: schema.arkCollections.arkId,
        naan: schema.organization.arkNaan,
      })
      .from(schema.arkCollections)
      .innerJoin(schema.collections, eq(schema.arkCollections.collectionId, schema.collections.id))
      .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
      .innerJoin(
        schema.arkShoulders,
        eq(schema.arkShoulders.organizationId, schema.organization.id),
      )
      .where(
        and(
          eq(schema.arkCollections.collectionId, collectionId),
          eq(schema.arkCollections.enabled, true),
        ),
      )
      .limit(1)
    if (!row) return null
    return { shoulder: row.shoulder, arkId: row.arkId, naan: row.naan ?? DEFAULT_NAAN }
  } catch (err) {
    console.error(`[ark] Failed to load ARK info for collection ${collectionId}:`, err)
    return null
  }
}

export default app
