/**
 * File routes, mounted at /api/collections.
 *
 *   HEAD|GET /:owner/:slug/files/:hash               302 to a presigned URL (v1 contract)
 *   POST     /:owner/:slug/files/presign             {hashes} → {hash: url|null} (read-only)
 *   PUT      /:owner/:slug/files/:hash               small upload through the API
 *   POST     /:owner/:slug/files/uploads             start a direct upload → presigned PUT or parts
 *   POST     /:owner/:slug/files/uploads/:id/complete
 *   GET      /:owner/:slug/files/uploads/:id         pending | verifying | verified | failed
 */
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { meter } from '../billing/usage.js'
import * as schema from '../db/schema.js'
import {
  canReadFile,
  cleanHash,
  completeUpload,
  isHash,
  presignDownload,
  presignDownloads,
  PRESIGN_SECONDS,
  readableFiles,
  safeMimeType,
  SMALL_UPLOAD_BYTES,
  startUpload,
  storeSmallFile,
} from '../files/files.js'
import { isDenied } from '../lib/limits.js'
import { fileSizes } from '../versions/file-refs.js'
import { jsonError, requireCollection } from './access.js'

export function fileRoutes() {
  const app = new Hono<AppEnv>()

  // Hono routes HEAD to GET handlers, so one handler serves both.
  app.get('/:owner/:slug/files/:hash', async (c) => {
    const head = c.req.method === 'HEAD'
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return head ? c.body(null, 404) : access
    const hash = cleanHash(c.req.param('hash'))
    if (await isDenied(c.var.ports.db, hash)) {
      return head ? c.body(null, 451) : jsonError(c, 451, 'This file is unavailable')
    }
    if (
      !isHash(hash) ||
      !(await canReadFile(c.var.ports, access.collection, access.isMember, hash))
    ) {
      return head ? c.body(null, 404) : jsonError(c, 404, 'File not found')
    }
    const [f] = await c.var.ports.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, hash))
      .limit(1)
    if (!f) return head ? c.body(null, 404) : jsonError(c, 404, 'File not found')
    if (head)
      return c.body(null, 200, { 'content-length': String(f.size), 'content-type': f.mimeType })
    meter(c.var.meter, 'file_downloads', 1)
    meter(c.var.meter, 'file_bytes', f.size)
    // The presigned URL lasts PRESIGN_SECONDS: a browser may reuse the redirect until shortly before.
    c.header('cache-control', `private, max-age=${PRESIGN_SECONDS - 60}`)
    return c.redirect((await presignDownload(c.var.ports, hash))!, 302)
  })

  app.post('/:owner/:slug/files/presign', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const body = (await c.req.json().catch(() => null)) as { hashes?: unknown } | null
    if (!Array.isArray(body?.hashes) || body.hashes.length > 500) {
      return jsonError(c, 400, '"hashes" must be an array of at most 500 file hashes')
    }
    // The head's trees and the file rows are read once, not per hash (D1: 1,000 queries).
    const requested = body.hashes.filter((h): h is string => typeof h === 'string')
    const valid = requested.map(cleanHash).filter(isHash)
    const readable = await readableFiles(c.var.ports, access.collection, access.isMember, valid)
    const urls = await presignDownloads(c.var.ports, [...readable])
    const out: Record<string, string | null> = {}
    for (const r of requested) out[r] = urls.get(cleanHash(r)) ?? null
    // A presigned URL is a download handed out: metered as one, at the file's size.
    for (const s of await fileSizes(c.var.ports.db, [...urls.keys()])) {
      meter(c.var.meter, 'file_downloads', 1)
      meter(c.var.meter, 'file_bytes', s[1])
    }
    return c.json(out)
  })

  app.put('/:owner/:slug/files/:hash', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const hash = cleanHash(c.req.param('hash'))
    if (!isHash(hash)) return jsonError(c, 400, 'Not a sha256 file hash')
    const declared = Number(c.req.header('content-length') ?? NaN)
    if (declared > SMALL_UPLOAD_BYTES) {
      return jsonError(
        c,
        413,
        `Uploads through the API are limited to ${SMALL_UPLOAD_BYTES} bytes; use POST .../files/uploads for larger files`,
      )
    }
    const type = c.req.header('content-type') ?? 'application/octet-stream'
    let bytes: Uint8Array
    let mime: string
    if (type.startsWith('multipart/')) {
      const form = await c.req.parseBody()
      const file = form.file
      if (!(file instanceof File)) return jsonError(c, 400, 'No file in multipart body')
      bytes = new Uint8Array(await file.arrayBuffer())
      mime = file.type
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer())
      mime = type
    }
    if (bytes.byteLength > SMALL_UPLOAD_BYTES)
      return jsonError(c, 413, `File exceeds ${SMALL_UPLOAD_BYTES} bytes`)
    const result = await storeSmallFile(
      c.var.ports,
      access.collection.id,
      hash,
      bytes,
      safeMimeType(mime),
    )
    if (result === 'mismatch') return jsonError(c, 400, 'Hash mismatch', { expected: hash })
    return c.json({ hash, status: 'stored', size: bytes.byteLength }, 201)
  })

  app.post('/:owner/:slug/files/uploads', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const body = (await c.req.json().catch(() => null)) as {
      hash?: unknown
      size?: unknown
      mimeType?: unknown
    } | null
    const hash = typeof body?.hash === 'string' ? cleanHash(body.hash) : ''
    const size = Number(body?.size)
    if (!isHash(hash)) return jsonError(c, 400, '"hash" must be a sha256 file hash')
    if (!Number.isSafeInteger(size) || size < 0)
      return jsonError(c, 400, '"size" must be a byte count')
    const ticket = await startUpload(c.var.ports, access.collection.id, {
      hash,
      size,
      mimeType: safeMimeType(typeof body?.mimeType === 'string' ? body.mimeType : undefined),
    })
    return c.json(ticket, 201)
  })

  app.post('/:owner/:slug/files/uploads/:id/complete', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const [u] = await c.var.ports.db
      .select()
      .from(schema.fileUploads)
      .where(
        and(
          eq(schema.fileUploads.id, c.req.param('id')),
          eq(schema.fileUploads.collectionId, access.collection.id),
        ),
      )
      .limit(1)
    if (!u) return jsonError(c, 404, 'Upload not found')
    const body = (await c.req.json().catch(() => ({}))) as {
      parts?: { partNumber: number; etag: string }[]
    }
    await completeUpload(c.var.ports, u, body.parts)
    return c.json({ id: u.id, status: 'verifying' }, 202)
  })

  app.get('/:owner/:slug/files/uploads/:id', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const [u] = await c.var.ports.db
      .select()
      .from(schema.fileUploads)
      .where(
        and(
          eq(schema.fileUploads.id, c.req.param('id')),
          eq(schema.fileUploads.collectionId, access.collection.id),
        ),
      )
      .limit(1)
    if (!u) return jsonError(c, 404, 'Upload not found')
    return c.json({ id: u.id, hash: u.hash, size: u.size, status: u.status, error: u.error })
  })

  return app
}
