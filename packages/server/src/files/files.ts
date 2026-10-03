/**
 * Files (edge-redesign.md, "Files"): SHA-256-of-bytes ids, bytes never served
 * from the app's origin (presigned URLs on the bucket's domain), uploads
 * verified before a file exists.
 *
 * Upload paths:
 *   - small: PUT through the API, hashed in memory (bounded by SMALL_UPLOAD_BYTES);
 *   - direct: a presigned PUT (or multipart part URLs) to a staging key, then a
 *     job streams the object, checks its hash, and copies it to the canonical
 *     repository key `files/<hash>` (mirrors need canonical keys; staging keys
 *     can then expire by lifecycle rule).
 *
 * Proof of possession: an upload always carries the bytes, even when the
 * server already has the file, so "do you have X?" is never answered for free.
 */
import { createHash } from 'node:crypto'

import { copyObject, fileTree, getEntry, RepoSource } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'

/** PUT-through-the-API limit: the body is held in isolate memory to hash it. */
export const SMALL_UPLOAD_BYTES = 32 * 1024 * 1024
/** Single presigned PUT limit (S3/R2); larger files use multipart. */
export const SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024
/** Server-side copy limit; past it the verified staging object would need UploadPartCopy. */
export const COPY_LIMIT_BYTES = 5 * 1024 * 1024 * 1024
export const PART_BYTES = 100 * 1024 * 1024
export const PRESIGN_SECONDS = 300

// Types that render or run in a browser are stored as inert bytes (v1 rule).
const UNSAFE_MIME = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml)/i
export const safeMimeType = (mime: string | undefined) =>
  !mime || UNSAFE_MIME.test(mime.trim()) ? 'application/octet-stream' : mime.trim()

const HEX64 = /^[0-9a-f]{64}$/
export const cleanHash = (h: string) => h.replace(/^sha256:/, '').toLowerCase()
export const isHash = (h: string) => HEX64.test(h)

/**
 * May this caller read this file through this collection? Non-members: the file
 * is in the collection's cumulative public files tree. Members: also the head's
 * file trees (both sets).
 */
export async function canReadFile(
  ports: Ports,
  collection: typeof schema.collections.$inferSelect,
  member: boolean,
  hash: string,
): Promise<boolean> {
  const repo = await ports.stores.forCollection(collection.id)
  const source = new RepoSource(fileTree, repo)
  if (await getEntry(source, collection.publicFilesRoot, hash)) return true
  if (!member || !collection.headVersionId) return false
  const [v] = await ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.id, collection.headVersionId))
  if (!v) return false
  const root = await repo.root(v.hash)
  if (await getEntry(source, root.public.files.root, hash)) return true
  if (!root.private) return false
  const priv = await repo.privateSet(root.private)
  return !!(await getEntry(source, priv.files.root, hash))
}

export async function presignDownload(ports: Ports, hash: string): Promise<string | null> {
  const [f] = await ports.db.select().from(schema.files).where(eq(schema.files.hash, hash)).limit(1)
  if (!f) return null
  // Downloads are attachments: nothing renders on the bucket's domain either.
  return ports.stores.fileBytes.presigner.presignGet(f.storageKey, {
    expiresIn: PRESIGN_SECONDS,
    disposition: `attachment; filename="${hash}"`,
    contentType: f.mimeType,
  })
}

/** Store verified bytes at the canonical key and record the file. Idempotent. */
export async function storeSmallFile(
  ports: Ports,
  hash: string,
  bytes: Uint8Array,
  mime: string,
): Promise<'stored' | 'mismatch'> {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== hash) return 'mismatch'
  const [existing] = await ports.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.hash, hash))
    .limit(1)
  if (existing) return 'stored'
  const key = ports.stores.canonicalFileKey(hash)
  await ports.stores.fileBytes.put(key, bytes, { contentType: mime, ifAbsent: true })
  await ports.db
    .insert(schema.files)
    .values({
      hash,
      size: bytes.byteLength,
      mimeType: mime,
      storageKey: key,
      verifiedAt: new Date(),
    })
    .onConflictDoNothing()
  return 'stored'
}

export interface UploadTicket {
  id: string
  url?: string
  parts?: { partNumber: number; url: string }[]
  expiresIn: number
}

/** Start a direct upload to a staging key; returns where the client PUTs bytes. */
export async function startUpload(
  ports: Ports,
  collectionId: string,
  req: { hash: string; size: number; mimeType: string },
): Promise<UploadTicket> {
  const id = crypto.randomUUID()
  const key = ports.stores.stagingKey(id)
  const blobs = ports.stores.fileBytes
  let multipartUploadId: string | null = null
  const ticket: UploadTicket = { id, expiresIn: 3600 }
  if (req.size <= SINGLE_PUT_BYTES) {
    ticket.url = await blobs.presigner.presignPut(key, { expiresIn: 3600 })
  } else {
    multipartUploadId = await blobs.presigner.createMultipart(key, req.mimeType)
    const n = Math.ceil(req.size / PART_BYTES)
    ticket.parts = await Promise.all(
      Array.from({ length: n }, async (_, i) => ({
        partNumber: i + 1,
        url: await blobs.presigner.presignPart(key, multipartUploadId!, i + 1, 3600),
      })),
    )
  }
  await ports.db.insert(schema.fileUploads).values({
    id,
    collectionId,
    hash: req.hash,
    size: req.size,
    mimeType: req.mimeType,
    storageKey: key,
    multipartUploadId,
  })
  return ticket
}

export async function completeUpload(
  ports: Ports,
  upload: typeof schema.fileUploads.$inferSelect,
  parts: { partNumber: number; etag: string }[] | undefined,
): Promise<void> {
  if (upload.multipartUploadId) {
    if (!parts?.length) throw new Error('Multipart uploads complete with their parts')
    await ports.stores.fileBytes.presigner.completeMultipart(
      upload.storageKey,
      upload.multipartUploadId,
      parts,
    )
  }
  const claimed = await ports.db
    .update(schema.fileUploads)
    .set({ status: 'verifying' })
    .where(and(eq(schema.fileUploads.id, upload.id), eq(schema.fileUploads.status, 'pending')))
    .returning({ id: schema.fileUploads.id })
  if (claimed.length === 1) await ports.jobs.enqueue({ type: 'files.verify', uploadId: upload.id })
}

/**
 * Verify a staged upload: stream it, hash it, and on a match make it a file.
 * One job hashes at roughly 1 GB/s of CPU; files past what fits in one job's
 * CPU budget need a resumable SHA-256 (edge-redesign.md, Files).
 */
export async function verifyUpload(ports: Ports, uploadId: string): Promise<void> {
  const [u] = await ports.db
    .select()
    .from(schema.fileUploads)
    .where(eq(schema.fileUploads.id, uploadId))
    .limit(1)
  if (!u || u.status !== 'verifying') return
  const blobs = ports.stores.fileBytes
  const fail = async (error: string) => {
    await ports.db
      .update(schema.fileUploads)
      .set({ status: 'failed', error })
      .where(eq(schema.fileUploads.id, uploadId))
    await blobs.delete(u.storageKey)
  }
  const obj = await blobs.get(u.storageKey)
  if (!obj) return fail('Nothing was uploaded')
  const h = createHash('sha256')
  let size = 0
  const reader = obj.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    h.update(value)
    size += value.byteLength
  }
  const actual = h.digest('hex')
  if (actual !== u.hash) return fail(`Hash mismatch: uploaded bytes hash to ${actual}`)
  if (size !== u.size) return fail(`Size mismatch: ${size} bytes, declared ${u.size}`)

  const [existing] = await ports.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.hash, u.hash))
    .limit(1)
  if (!existing) {
    let storageKey = ports.stores.canonicalFileKey(u.hash)
    if (size <= COPY_LIMIT_BYTES) {
      await copyObject(blobs, u.storageKey, storageKey)
    } else {
      // TODO(files): UploadPartCopy for >5 GB. Until then the staging object is kept
      // as the file; the staging lifecycle rule must not cover verified uploads.
      storageKey = u.storageKey
    }
    await ports.db
      .insert(schema.files)
      .values({ hash: u.hash, size, mimeType: u.mimeType, storageKey, verifiedAt: new Date() })
      .onConflictDoNothing()
    if (storageKey === u.storageKey) {
      await ports.db
        .update(schema.fileUploads)
        .set({ status: 'verified' })
        .where(eq(schema.fileUploads.id, uploadId))
      return
    }
  }
  await blobs.delete(u.storageKey)
  await ports.db
    .update(schema.fileUploads)
    .set({ status: 'verified' })
    .where(eq(schema.fileUploads.id, uploadId))
}

registerJob('files.verify', async (job, ports) => verifyUpload(ports, String(job.uploadId)))
