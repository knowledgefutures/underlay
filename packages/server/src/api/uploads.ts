/**
 * Client-built uploads to a v3 collection (v3/uploads.ts; v3-deploy-plan.md, Phase 2),
 * mounted at /api/collections:
 *
 *   POST   /:owner/:slug/uploads                          open one {message?, base?, app_id?}
 *   POST   /:owner/:slug/uploads/:id/files                {id, size} → a presigned PUT, or parts
 *   POST   /:owner/:slug/uploads/:id/files/:fid/complete  {upload_id, parts: [{n, etag}]}
 *   POST   /:owner/:slug/uploads/:id/commit               {files: [FileRef…], change?}
 *   GET    /:owner/:slug/uploads/:id                      status, files present, result
 *   DELETE /:owner/:slug/uploads/:id                      abandon
 *
 * A file's id is its content's (docs/protocol-v3.md, 3.4); the client builds it with the
 * library. The commit is verified and landed by jobs: poll the status until `committed`.
 */
import { v3 } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import {
  checkCommitBody,
  completeFile,
  getUpload,
  openUpload,
  presentFiles,
  presignFile,
  requestCommit,
  uploadLimits,
  type UploadRow,
} from '../v3/uploads.js'
import { type CollectionAccess, jsonError, requireCollection } from './access.js'
import { readJson } from './body.js'

const HEX64 = /^[0-9a-f]{64}$/

async function v3Collection(c: Context<AppEnv>): Promise<CollectionAccess | Response> {
  const access = await requireCollection(c, 'write')
  if (access instanceof Response) return access
  if (access.collection.recordLayout !== 'v3') {
    return jsonError(c, 409, 'Uploads are for v3 collections; push to this one with /push')
  }
  return access
}

async function ownUpload(
  c: Context<AppEnv>,
  access: CollectionAccess,
): Promise<UploadRow | Response> {
  const u = await getUpload(c.var.ports, c.req.param('id') ?? '')
  if (!u || u.collectionId !== access.collection.id) return jsonError(c, 404, 'Upload not found')
  if (u.userId !== c.var.principal?.userId) return jsonError(c, 403, 'Not your upload')
  return u
}

const statusBody = (u: UploadRow, present?: string[]) => ({
  upload_id: u.id,
  status: u.status,
  expires_at: u.expiresAt,
  files_named: Array.isArray(u.files) ? u.files.length : 0,
  files_verified: u.verified,
  ...(present ? { present } : {}),
  result: u.result ?? null,
  error: u.error ?? null,
})

export function uploadRoutes() {
  const app = new Hono<AppEnv>()

  app.post('/:owner/:slug/uploads', async (c) => {
    const access = await v3Collection(c)
    if (access instanceof Response) return access
    const body = await readJson(c, 64 * 1024)
    if (body instanceof Response) return body
    const str = (v: unknown) => (typeof v === 'string' ? v : null)
    const u = await openUpload(c.var.ports, access.collection.id, c.var.principal!.userId, {
      message: str(body.message),
      base: str(body.base),
      appId: str(body.app_id),
    })
    if (!u) return jsonError(c, 429, `At most ${uploadLimits.open} open uploads`)
    return c.json(
      {
        upload_id: u.id,
        expires_at: u.expiresAt,
        limits: {
          files: uploadLimits.files,
          single_put_bytes: uploadLimits.singlePutBytes,
          part_bytes: uploadLimits.partBytes,
          max_file_bytes: uploadLimits.maxFileBytes,
        },
      },
      201,
    )
  })

  app.post('/:owner/:slug/uploads/:id/files', async (c) => {
    const access = await v3Collection(c)
    if (access instanceof Response) return access
    const u = await ownUpload(c, access)
    if (u instanceof Response) return u
    if (u.status !== 'open') return jsonError(c, 409, `Upload is ${u.status}`)
    const body = await readJson(c, 4096)
    if (body instanceof Response) return body
    const id = String(body.id ?? '')
    const size = Number(body.size)
    if (!HEX64.test(id)) return jsonError(c, 400, '"id" must be a file id (64 hex)')
    if (!Number.isSafeInteger(size) || size <= 0 || size > uploadLimits.maxFileBytes)
      return jsonError(c, 400, `"size" must be 1 to ${uploadLimits.maxFileBytes} bytes`)
    return c.json(await presignFile(c.var.ports, u, id, size))
  })

  app.post('/:owner/:slug/uploads/:id/files/:fid/complete', async (c) => {
    const access = await v3Collection(c)
    if (access instanceof Response) return access
    const u = await ownUpload(c, access)
    if (u instanceof Response) return u
    if (u.status !== 'open') return jsonError(c, 409, `Upload is ${u.status}`)
    const body = await readJson(c, 1024 * 1024)
    if (body instanceof Response) return body
    const fid = c.req.param('fid')
    const parts = body.parts as { n: number; etag: string }[] | undefined
    if (!HEX64.test(fid) || typeof body.upload_id !== 'string' || !Array.isArray(parts))
      return jsonError(c, 400, 'Needs {upload_id, parts: [{n, etag}]}')
    await completeFile(c.var.ports, u, fid, body.upload_id, parts)
    return c.json({ ok: true })
  })

  app.post('/:owner/:slug/uploads/:id/commit', async (c) => {
    const access = await v3Collection(c)
    if (access instanceof Response) return access
    const u = await ownUpload(c, access)
    if (u instanceof Response) return u
    const body = await readJson(c, 16 * 1024 * 1024)
    if (body instanceof Response) return body
    const checked = checkCommitBody(body)
    if (typeof checked === 'string') return jsonError(c, 400, checked)
    // A change the client signed names the same files, for this collection.
    let change: v3.Change | null = null
    if (body.change !== undefined) {
      change = body.change as v3.Change
      if (
        change?.collection !== access.collection.id ||
        JSON.stringify(change.files) !== JSON.stringify(checked.files)
      )
        return jsonError(c, 400, '"change" must be for this collection and name the same files')
    }
    if (!(await requestCommit(c.var.ports, u, checked.files, change))) {
      const now = await getUpload(c.var.ports, u.id)
      return jsonError(c, 409, `Upload is ${now?.status ?? 'gone'}`)
    }
    return c.json(
      {
        upload_id: u.id,
        status: 'verifying',
        poll: `GET ${new URL(c.req.url).pathname.replace(/\/commit$/, '')}`,
      },
      202,
    )
  })

  app.get('/:owner/:slug/uploads/:id', async (c) => {
    const access = await v3Collection(c)
    if (access instanceof Response) return access
    const u = await ownUpload(c, access)
    if (u instanceof Response) return u
    const present = u.status === 'open' ? await presentFiles(c.var.ports, u.id) : undefined
    return c.json(statusBody(u, present))
  })

  app.delete('/:owner/:slug/uploads/:id', async (c) => {
    const access = await v3Collection(c)
    if (access instanceof Response) return access
    const u = await ownUpload(c, access)
    if (u instanceof Response) return u
    await c.var.ports.db
      .update(schema.v3Uploads)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(schema.v3Uploads.id, u.id), eq(schema.v3Uploads.status, 'open')))
    return c.json({ ok: true })
  })

  return app
}
