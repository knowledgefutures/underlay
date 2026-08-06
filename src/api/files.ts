import { createHash } from 'node:crypto'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { getPresignedFileUrl, getS3ObjectMeta, uploadToS3 } from '../lib/s3.js'
import { hasOrgAccess } from '../lib/version-helpers.server.js'
import { type AuthEnv } from './auth.server.js'
import { requireAuth } from './auth.server.js'

const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_FILE_UPLOAD_BYTES ?? '', 10) || 100 * 1024 * 1024 // 100 MB

// Content types that render/execute inline in a browser are coerced to an
// inert type on storage, so an uploaded object can never act as a page even if
// it is later served without a forced download.
const UNSAFE_MIME_RE = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml)/i
function safeMimeType(mime: string): string {
  return UNSAFE_MIME_RE.test(mime.trim()) ? 'application/octet-stream' : mime
}

async function isFilePubliclyAccessible(
  owner: string,
  slug: string,
  fileHash: string,
  userId: string | undefined,
  apiKeyCollectionIds?: string[],
): Promise<boolean> {
  const [collection] = await db
    .select({
      id: schema.collections.id,
      organizationId: schema.collections.organizationId,
      public: schema.collections.public,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)

  if (!collection) return false

  // A collection-scoped API key (share/agent link) only counts for the
  // collections it is scoped to.
  const keyScopeOk = !apiKeyCollectionIds || apiKeyCollectionIds.includes(collection.id)

  // The file must actually belong to THIS collection (in any of its versions).
  // Without this, the owner/slug in the path is decorative: a member could fetch
  // any file in the system by requesting it under a collection they belong to.
  const [belongs] = await db
    .select({ fileHash: schema.versionFiles.fileHash })
    .from(schema.versionFiles)
    .innerJoin(schema.versions, eq(schema.versionFiles.versionId, schema.versions.id))
    .where(
      and(
        eq(schema.versions.collectionId, collection.id),
        eq(schema.versionFiles.fileHash, fileHash),
      ),
    )
    .limit(1)
  if (!belongs) return false

  if (userId != null && keyScopeOk) {
    const [membership] = await db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, collection.organizationId),
          eq(schema.member.userId, userId),
        ),
      )
      .limit(1)
    if (membership) return true
  }

  // Non-members get files only from PUBLIC collections. Without this a file in a
  // private collection was downloadable by anyone who knew its hash.
  if (!collection.public) return false

  // OR across every ready version: a file is accessible if it is referenced via
  // a non-private field of a non-private record of a non-private type in ANY
  // ready version of this (public) collection. Files are content-addressed and
  // immutable, and the URL carries no version, so "published publicly in any
  // accessible version ⇒ public" is the correct resolution.
  const candidates = await db
    .select({
      versionId: schema.versionRecords.versionId,
      type: schema.recordObjects.type,
      data: schema.recordObjects.data,
    })
    .from(schema.versionRecords)
    .innerJoin(schema.versions, eq(schema.versionRecords.versionId, schema.versions.id))
    .innerJoin(
      schema.recordObjects,
      eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
    )
    .where(
      and(
        eq(schema.versions.collectionId, collection.id),
        eq(schema.versions.status, 'ready'),
        eq(schema.versionRecords.private, false),
        sql`${schema.recordObjects.data}::text LIKE ${'%' + fileHash + '%'}`,
      ),
    )
    .limit(50)

  if (candidates.length === 0) return false

  // Type/field privacy is per-version; load each candidate version's schema once.
  const schemaCache = new Map<
    number,
    { privateTypes: Set<string>; typeSchemas: Map<string, Record<string, any>> }
  >()
  const loadVersionPrivacy = async (versionId: number) => {
    const cached = schemaCache.get(versionId)
    if (cached) return cached
    const entries = await db
      .select({ slug: schema.versionSchemas.slug, schemaBody: schema.schemas.schema })
      .from(schema.versionSchemas)
      .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
      .where(eq(schema.versionSchemas.versionId, versionId))
    const privateTypes = new Set<string>()
    const typeSchemas = new Map<string, Record<string, any>>()
    for (const e of entries) {
      const body = e.schemaBody as Record<string, any>
      typeSchemas.set(e.slug, body)
      if (body?.private === true) privateTypes.add(e.slug)
    }
    const value = { privateTypes, typeSchemas }
    schemaCache.set(versionId, value)
    return value
  }

  for (const rec of candidates) {
    const { privateTypes, typeSchemas } = await loadVersionPrivacy(rec.versionId)
    if (privateTypes.has(rec.type)) continue

    const typeProps = typeSchemas.get(rec.type)?.properties as Record<string, any> | undefined
    const privateFields = new Set<string>()
    if (typeProps) {
      for (const [fieldName, fieldDef] of Object.entries(typeProps)) {
        if ((fieldDef as any)?.private === true) privateFields.add(fieldName)
      }
    }

    // `$file` refs may be nested inside objects/arrays, so search recursively
    // within each non-private top-level field (field privacy is top-level only).
    const containsRef = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false
      const ref = (value as { $file?: unknown }).$file
      if (typeof ref === 'string') return ref === `sha256:${fileHash}`
      return Object.values(value as Record<string, unknown>).some(containsRef)
    }

    const data = rec.data as Record<string, any>
    for (const [key, val] of Object.entries(data)) {
      if (privateFields.has(key)) continue
      if (containsRef(val)) return true
    }
  }

  return false
}

const fileParams = z.object({
  owner: z.string(),
  slug: z.string(),
  hash: z.string(),
})

const app = new Hono<AuthEnv>()
  .on('HEAD', '/:owner/:slug/files/:hash', async (c) => {
    const owner = c.req.param('owner')!
    const slug = c.req.param('slug')!
    const hash = c.req.param('hash')!
    const cleanHash = hash.replace('sha256:', '')

    const [file] = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, cleanHash))
      .limit(1)

    if (!file) {
      return c.body(null, 404)
    }

    const accessible = await isFilePubliclyAccessible(
      owner,
      slug,
      cleanHash,
      c.get('userId'),
      c.get('apiKeyCollectionIds'),
    )
    if (!accessible) {
      return c.body(null, 404)
    }

    c.header('Content-Length', String(file.size))
    c.header('Content-Type', file.mimeType)
    return c.body(null, 200)
  })
  .get(
    '/:owner/:slug/files/:hash',
    openApi({
      tags: ['Files'],
      summary: 'Download a file by hash',
      request: { param: fileParams },
      responses: { 302: z.any(), 404: z.object({ error: z.string() }) },
    }),
    async (c) => {
      const { owner, slug, hash } = c.req.valid('param')
      const cleanHash = hash.replace('sha256:', '')

      const [file] = await db
        .select()
        .from(schema.files)
        .where(eq(schema.files.hash, cleanHash))
        .limit(1)

      if (!file) {
        return c.json({ error: 'File not found', statusCode: 404 }, 404)
      }

      const accessible = await isFilePubliclyAccessible(
        owner,
        slug,
        cleanHash,
        c.get('userId'),
        c.get('apiKeyCollectionIds'),
      )
      if (!accessible) {
        return c.json({ error: 'File not found', statusCode: 404 }, 404)
      }

      // Files live in a private bucket; mint a short-lived presigned URL now that
      // the access check has passed, so the object is never reachable by hash
      // alone from the storage origin.
      const signedUrl = await getPresignedFileUrl(file.storageKey)
      return c.redirect(signedUrl)
    },
  )
  // Collection-agnostic download (used by the global record-provenance page):
  // presign only if the file is accessible through at least one collection the
  // caller may read.
  .get(
    '/files/:hash',
    openApi({
      tags: ['Files'],
      summary: 'Download a file by hash (collection-agnostic)',
      request: { param: z.object({ hash: z.string() }) },
      responses: { 302: z.any(), 404: z.object({ error: z.string() }) },
    }),
    async (c) => {
      const cleanHash = c.req.param('hash').replace('sha256:', '')

      const [file] = await db
        .select()
        .from(schema.files)
        .where(eq(schema.files.hash, cleanHash))
        .limit(1)
      if (!file) return c.json({ error: 'File not found', statusCode: 404 }, 404)

      // Candidate collections that contain this file; the per-collection check
      // enforces public-vs-private and the non-private-reference requirement.
      const candidates = await db
        .selectDistinct({ owner: schema.organization.slug, slug: schema.collections.slug })
        .from(schema.versionFiles)
        .innerJoin(schema.versions, eq(schema.versionFiles.versionId, schema.versions.id))
        .innerJoin(schema.collections, eq(schema.versions.collectionId, schema.collections.id))
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(eq(schema.versionFiles.fileHash, cleanHash))
        .limit(50)

      let accessible = false
      for (const cand of candidates) {
        if (
          await isFilePubliclyAccessible(
            cand.owner,
            cand.slug,
            cleanHash,
            c.get('userId'),
            c.get('apiKeyCollectionIds'),
          )
        ) {
          accessible = true
          break
        }
      }
      if (!accessible) return c.json({ error: 'File not found', statusCode: 404 }, 404)

      const signedUrl = await getPresignedFileUrl(file.storageKey)
      return c.redirect(signedUrl)
    },
  )
  // Bulk presign: resolve the (caller, owner, slug) context once and check each
  // hash, so a page referencing many files makes one request instead of N. Same
  // access model as the single GET; returns a presigned URL per accessible hash
  // and null otherwise. (Share-link callers pass their token as a Bearer header;
  // the query-param token is GET/HEAD-only and does not authenticate this POST.)
  .post(
    '/:owner/:slug/files/presign',
    openApi({
      tags: ['Files'],
      summary: 'Presign a batch of files by hash',
      request: {
        param: z.object({ owner: z.string(), slug: z.string() }),
        json: z.object({ hashes: z.array(z.string()).max(500) }),
      },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const { hashes } = c.req.valid('json')
      const userId = c.get('userId')
      const scoped = c.get('apiKeyCollectionIds')

      // Keys in the response are echoed back EXACTLY as the caller sent them
      // (`sha256:`-prefixed or not), so a client can look up what it asked for.
      const requested = [...new Set(hashes)]
      const cleanOf = new Map(requested.map((h) => [h, h.replace('sha256:', '')]))
      const clean = [...new Set(cleanOf.values())]

      const fileRows = clean.length
        ? await db
            .select({ hash: schema.files.hash, storageKey: schema.files.storageKey })
            .from(schema.files)
            .where(inArray(schema.files.hash, clean))
        : []
      const storageByHash = new Map(fileRows.map((f) => [f.hash, f.storageKey]))

      // Resolve access once per distinct hash, even if requested in both forms.
      const urlByClean = new Map<string, string | null>()
      for (const h of clean) {
        const storageKey = storageByHash.get(h)
        if (!storageKey) {
          urlByClean.set(h, null)
          continue
        }
        const ok = await isFilePubliclyAccessible(owner, slug, h, userId, scoped)
        urlByClean.set(h, ok ? await getPresignedFileUrl(storageKey) : null)
      }

      const result: Record<string, string | null> = {}
      for (const h of requested) result[h] = urlByClean.get(cleanOf.get(h)!) ?? null
      return c.json(result)
    },
  )
  .put(
    '/:owner/:slug/files/:hash',
    requireAuth('write'),
    openApi({
      tags: ['Files'],
      summary: 'Upload a file',
      request: { param: fileParams },
      responses: { 200: z.any(), 201: z.any() },
    }),
    async (c) => {
      const { owner, slug, hash } = c.req.valid('param')
      const cleanHash = hash.replace('sha256:', '')

      // Files are content-addressed and shared, but a write must still be tied to
      // a collection the caller can actually push to — otherwise any write-scoped
      // credential (including an agent link) could upload into global storage.
      const [uploadCollection] = await db
        .select({ id: schema.collections.id, organizationId: schema.collections.organizationId })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
        .limit(1)
      if (!uploadCollection) {
        return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
      }
      const scopedCollections = c.get('apiKeyCollectionIds')
      if (scopedCollections && !scopedCollections.includes(uploadCollection.id)) {
        return c.json({ error: 'API key is not scoped to this collection', statusCode: 403 }, 403)
      }
      if (!(await hasOrgAccess(c.get('userId'), uploadCollection.organizationId))) {
        return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
      }

      const [existing] = await db
        .select()
        .from(schema.files)
        .where(eq(schema.files.hash, cleanHash))
        .limit(1)

      if (existing) {
        return c.json({ hash: cleanHash, status: 'exists' }, 200)
      }

      const s3Key = `files/${cleanHash.slice(0, 2)}/${cleanHash.slice(2, 4)}/${cleanHash}`
      const s3Meta = await getS3ObjectMeta(s3Key)
      if (s3Meta !== null) {
        await db
          .insert(schema.files)
          .values({
            hash: cleanHash,
            size: s3Meta.size,
            mimeType: s3Meta.contentType,
            storageKey: s3Key,
          })
          .onConflictDoNothing()
        return c.json({ hash: cleanHash, status: 'exists' }, 200)
      }

      const contentType = c.req.header('content-type') ?? 'application/octet-stream'

      // Uploads are buffered in memory for hashing, so cap the size (the
      // container heap is small). Reject early via Content-Length, and
      // re-check after reading since the header can be absent or wrong.
      const declaredLength = parseInt(c.req.header('content-length') ?? '0', 10)
      if (declaredLength > MAX_UPLOAD_BYTES) {
        return c.json(
          { error: `File exceeds upload limit of ${MAX_UPLOAD_BYTES} bytes`, statusCode: 413 },
          413,
        )
      }

      let buffer: Buffer
      let mimeType: string

      if (contentType.startsWith('multipart/')) {
        const body = await c.req.parseBody()
        const file = body['file']
        if (file instanceof File) {
          const ab = await file.arrayBuffer()
          buffer = Buffer.from(ab)
          mimeType = file.type || 'application/octet-stream'
        } else {
          return c.json({ error: 'No file in multipart body', statusCode: 400 }, 400)
        }
      } else {
        const ab = await c.req.arrayBuffer()
        buffer = Buffer.from(ab)
        mimeType = contentType
      }

      if (buffer.length > MAX_UPLOAD_BYTES) {
        return c.json(
          { error: `File exceeds upload limit of ${MAX_UPLOAD_BYTES} bytes`, statusCode: 413 },
          413,
        )
      }

      const computedHash = createHash('sha256').update(buffer).digest('hex')
      if (computedHash !== cleanHash) {
        return c.json(
          {
            error: 'Hash mismatch',
            expected: cleanHash,
            computed: computedHash,
            statusCode: 400,
          },
          400,
        )
      }

      const storageKey = `files/${cleanHash.slice(0, 2)}/${cleanHash.slice(2, 4)}/${cleanHash}`
      const storedMimeType = safeMimeType(mimeType)

      await uploadToS3(storageKey, buffer, storedMimeType)

      await db.insert(schema.files).values({
        hash: cleanHash,
        size: buffer.length,
        mimeType: storedMimeType,
        storageKey,
      })

      return c.json({ hash: cleanHash, size: buffer.length }, 201)
    },
  )

export default app
