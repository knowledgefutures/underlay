import { createHash } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { getS3ObjectMeta, uploadToS3 } from '../lib/s3.js'
import { type AuthEnv } from './auth.server.js'
import { requireAuth } from './auth.server.js'

const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_FILE_UPLOAD_BYTES ?? '', 10) || 100 * 1024 * 1024 // 100 MB

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
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)

  if (!collection) return false

  // A collection-scoped API key (share/agent link) only counts for the
  // collections it is scoped to.
  const keyScopeOk = !apiKeyCollectionIds || apiKeyCollectionIds.includes(collection.id)

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

  const [latest] = await db
    .select({ id: schema.versions.id })
    .from(schema.versions)
    .where(
      and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.status, 'ready')),
    )
    .orderBy(
      sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
    )
    .limit(1)

  if (!latest) return false

  const [vf] = await db
    .select({ fileHash: schema.versionFiles.fileHash })
    .from(schema.versionFiles)
    .where(
      and(eq(schema.versionFiles.versionId, latest.id), eq(schema.versionFiles.fileHash, fileHash)),
    )
    .limit(1)

  if (!vf) return false

  const schemaEntries = await db
    .select({
      slug: schema.versionSchemas.slug,
      schemaBody: schema.schemas.schema,
    })
    .from(schema.versionSchemas)
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(eq(schema.versionSchemas.versionId, latest.id))

  const privateTypes = new Set<string>()
  const typeSchemaMap = new Map<string, Record<string, any>>()
  for (const entry of schemaEntries) {
    const body = entry.schemaBody as Record<string, any>
    typeSchemaMap.set(entry.slug, body)
    if (body?.private === true) privateTypes.add(entry.slug)
  }

  const records = await db
    .select({ type: schema.recordObjects.type, data: schema.recordObjects.data })
    .from(schema.versionRecords)
    .innerJoin(
      schema.recordObjects,
      eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
    )
    .where(
      and(
        eq(schema.versionRecords.versionId, latest.id),
        eq(schema.recordObjects.private, false),
        sql`${schema.recordObjects.data}::text LIKE ${'%' + fileHash + '%'}`,
      ),
    )
    .limit(10)

  for (const rec of records) {
    if (privateTypes.has(rec.type)) continue

    const typeSchema = typeSchemaMap.get(rec.type)
    const typeProps = typeSchema?.properties as Record<string, any> | undefined
    if (!typeProps) return true

    const privateFields = new Set<string>()
    for (const [fieldName, fieldDef] of Object.entries(typeProps)) {
      if ((fieldDef as any)?.private === true) privateFields.add(fieldName)
    }

    const data = rec.data as Record<string, any>
    for (const [key, val] of Object.entries(data)) {
      if (privateFields.has(key)) continue
      if (
        val &&
        typeof val === 'object' &&
        '$file' in val &&
        (val as { $file: string }).$file === `sha256:${fileHash}`
      ) {
        return true
      }
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

      const cdnUrl = `https://assets.underlay.org/files/${cleanHash.slice(0, 2)}/${cleanHash.slice(2, 4)}/${cleanHash}`
      return c.redirect(cdnUrl)
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
      const { hash } = c.req.valid('param')
      const cleanHash = hash.replace('sha256:', '')

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

      await uploadToS3(storageKey, buffer, mimeType)

      await db.insert(schema.files).values({
        hash: cleanHash,
        size: buffer.length,
        mimeType,
        storageKey,
      })

      return c.json({ hash: cleanHash, size: buffer.length }, 201)
    },
  )

export default app
