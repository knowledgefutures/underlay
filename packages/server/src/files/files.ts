/**
 * Files (edge-redesign.md, "Files"): SHA-256-of-bytes ids, bytes never served
 * from the app's origin (presigned URLs on the bucket's domain), uploads
 * verified before a file exists.
 *
 * Upload paths:
 *   - small: PUT through the API, hashed in memory (bounded by SMALL_UPLOAD_BYTES);
 *   - direct: a presigned PUT (or multipart part URLs) to a staging key, then a
 *     job streams the object, checks its hash, and copies it to the canonical
 *     repository key `files/<hash>` (mirrors need canonical keys), then deletes
 *     the staging object. Abandoned ones go in storage cleanup (cleanup/internal.ts).
 *
 * Proof of possession: an upload always carries the bytes, even when the
 * server already has the file, so "do you have X?" is never answered for free.
 *
 * Storing a file reuses the bytes when a `files` row exists, so the files row
 * and the possession are written under the storage fence (cleanup/fence.ts):
 * if the sweep deleted an unused copy meanwhile, the store runs again and puts
 * the bytes back.
 */
import { createHash } from 'node:crypto'

import { copyObject, fileTree, getEntry, RepoSource } from '@underlay/protocol'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { FenceError, fenced, fenceHolds, fenceMoved } from '../cleanup/fence.js'
import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import { deniedHashes } from '../lib/limits.js'
import type { Db, Ports } from '../ports.js'

/** PUT-through-the-API limit: the body is held in isolate memory to hash it. */
export const SMALL_UPLOAD_BYTES = 32 * 1024 * 1024
/** Single presigned PUT limit (S3/R2); larger files use multipart. */
export const SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024
export const PART_BYTES = 100 * 1024 * 1024
export const PRESIGN_SECONDS = 300
/** The largest object R2 and S3 store, and the most parts a multipart upload has. */
export const MAX_FILE_BYTES = 5 * 1024 ** 4
export const MAX_PARTS = 10_000
/** Part URLs presigned per response: the ticket has the first page, the client asks for the rest. */
export const PARTS_PAGE = 100

/** A file's part size: PART_BYTES, or more (whole MiB) so it fits in MAX_PARTS parts. */
export function partBytesFor(size: number): number {
  const mib = 1024 * 1024
  return Math.max(PART_BYTES, Math.ceil(Math.ceil(size / MAX_PARTS) / mib) * mib)
}

/** Presigned URLs for parts `from` … `from + PARTS_PAGE - 1` of a multipart upload. */
export async function presignParts(
  ports: Ports,
  upload: { storageKey: string; multipartUploadId: string | null; size: number },
  from: number,
): Promise<{ partNumber: number; url: string }[]> {
  if (!upload.multipartUploadId) return []
  const count = Math.ceil(upload.size / partBytesFor(upload.size))
  const last = Math.min(count, from + PARTS_PAGE - 1)
  const presigner = ports.stores.fileBytes.presigner
  const parts: { partNumber: number; url: string }[] = []
  for (let n = Math.max(1, from); n <= last; n++) {
    parts.push({
      partNumber: n,
      url: await presigner.presignPart(upload.storageKey, upload.multipartUploadId, n, 3600),
    })
  }
  return parts
}

// Types that render or run in a browser are stored as inert bytes (v1 rule).
const UNSAFE_MIME = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml)/i
export const safeMimeType = (mime: string | undefined) =>
  !mime || UNSAFE_MIME.test(mime.trim()) ? 'application/octet-stream' : mime.trim()

const HEX64 = /^[0-9a-f]{64}$/
export const cleanHash = (h: string) => h.replace(/^sha256:/, '').toLowerCase()
export const isHash = (h: string) => HEX64.test(h)

/**
 * May this caller read this file through this collection? Non-members: the file
 * is in the collection's cumulative public files tree. Members, who read every
 * set: any file the collection holds, the same "held" a commit uses
 * (versions/file-refs.ts collectionFileSizes): also the head's file trees (both
 * sets), or bytes uploaded and verified under this collection.
 */
export async function canReadFile(
  ports: Ports,
  collection: typeof schema.collections.$inferSelect,
  member: boolean,
  hash: string,
): Promise<boolean> {
  return (await readableFiles(ports, collection, member, [hash])).has(hash)
}

/** canReadFile for many hashes, with the head's trees looked up once. */
export async function readableFiles(
  ports: Ports,
  collection: typeof schema.collections.$inferSelect,
  member: boolean,
  hashes: string[],
): Promise<Set<string>> {
  const repo = await ports.stores.forCollection(collection.id)
  const source = new RepoSource(fileTree, repo)
  const roots = [collection.publicFilesRoot]
  if (member && collection.headVersionId) {
    const [v] = await ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, collection.headVersionId))
    if (v) {
      const root = await repo.root(v.hash)
      roots.push(root.public.files.root)
      if (root.private) roots.push((await repo.privateSet(root.private)).files.root)
    }
  }
  const out = new Set<string>()
  const rest: string[] = []
  for (const h of hashes) {
    let found = false
    for (const r of roots) {
      if (r && (await getEntry(source, r, h))) {
        found = true
        break
      }
    }
    if (found) out.add(h)
    else rest.push(h)
  }
  if (member)
    for (const h of (await uploadedFiles(ports.db, collection.id, rest)).keys()) out.add(h)
  return out
}

/**
 * Of these hashes, the files whose bytes were uploaded and verified under this
 * collection (a `file_uploads` row), with their sizes: a query per JSON_CHUNK.
 * Together with the collection's file trees, what the collection holds.
 */
export async function uploadedFiles(
  db: Db,
  collectionId: string,
  hashes: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const part of chunks([...new Set(hashes)], JSON_CHUNK)) {
    const rows = await db
      .select({ hash: schema.files.hash, size: schema.files.size })
      .from(schema.files)
      .innerJoin(schema.fileUploads, eq(schema.fileUploads.hash, schema.files.hash))
      .where(
        and(
          inJson(schema.files.hash, part),
          eq(schema.fileUploads.collectionId, collectionId),
          eq(schema.fileUploads.status, 'verified'),
        ),
      )
    for (const r of rows) out.set(r.hash, r.size)
  }
  return out
}

/**
 * A filesystem store's `/_blob/…` response (Node entry), made inert: those
 * bytes come from the app's own origin, so an uploaded HTML or SVG file must
 * neither render nor run there. Always an attachment, sandboxed, never sniffed.
 */
export function inertBlobResponse(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('content-security-policy', 'sandbox')
  out.headers.set('x-content-type-options', 'nosniff')
  const disposition = out.headers.get('content-disposition')
  if (!disposition || !/^\s*attachment\b/i.test(disposition))
    out.headers.set('content-disposition', 'attachment')
  return out
}

export async function presignDownload(ports: Ports, hash: string): Promise<string | null> {
  return (await presignDownloads(ports, [hash])).get(hash) ?? null
}

/** Presigned download URLs for stored files, with the file rows read in chunks. */
export async function presignDownloads(
  ports: Ports,
  hashes: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  // Blocked files get no URL, whatever route asked (lib/limits.ts).
  const denied = await deniedHashes(ports.db)
  for (const part of chunks([...new Set(hashes)].filter((h) => !denied.has(h)))) {
    const rows = await ports.db.select().from(schema.files).where(inArray(schema.files.hash, part))
    for (const f of rows) {
      // Downloads are attachments: nothing renders on the bucket's domain either.
      out.set(
        f.hash,
        await ports.stores.fileBytes.presigner.presignGet(f.storageKey, {
          expiresIn: PRESIGN_SECONDS,
          disposition: `attachment; filename="${f.hash}"`,
          contentType: f.mimeType,
        }),
      )
    }
  }
  return out
}

/**
 * Store verified bytes at the canonical key and record the file, and that this
 * collection proved it holds them (a commit may then reference the file).
 * Idempotent.
 */
export async function storeSmallFile(
  ports: Ports,
  collectionId: string,
  hash: string,
  bytes: Uint8Array,
  mime: string,
): Promise<'stored' | 'mismatch'> {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== hash) return 'mismatch'
  await fenced(ports.db, async (fence) => {
    const [existing] = await ports.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, hash))
      .limit(1)
    const key = existing?.storageKey ?? ports.stores.canonicalFileKey(hash)
    if (!existing) {
      await ports.stores.fileBytes.put(key, bytes, { contentType: mime, ifAbsent: true })
      await recordFile(
        ports.db,
        { hash, size: bytes.byteLength, mimeType: mime, storageKey: key },
        fence,
      )
    }
    const [proved] = await ports.db
      .select({ id: schema.fileUploads.id })
      .from(schema.fileUploads)
      .where(
        and(
          eq(schema.fileUploads.collectionId, collectionId),
          eq(schema.fileUploads.hash, hash),
          eq(schema.fileUploads.status, 'verified'),
        ),
      )
      .limit(1)
    if (!proved) {
      const lit = <T>(v: unknown) => sql<T>`${v}`
      await ports.db.insert(schema.fileUploads).select(
        ports.db
          .select({
            id: lit<string>(crypto.randomUUID()).as('id'),
            collectionId: lit<string>(collectionId).as('collection_id'),
            sessionId: lit<string | null>(null).as('session_id'),
            hash: lit<string>(hash).as('hash'),
            size: lit<number>(bytes.byteLength).as('size'),
            mimeType: lit<string>(mime).as('mime_type'),
            storageKey: lit<string>(key).as('storage_key'),
            multipartUploadId: lit<string | null>(null).as('multipart_upload_id'),
            status: lit<string>('verified').as('status'),
            error: lit<string | null>(null).as('error'),
            createdAt: lit<number>(Date.now()).as('created_at'),
          })
          .from(schema.storageFence)
          .where(fenceHolds(fence)) as never,
      )
      if (await fenceMoved(ports.db, fence)) throw new FenceError()
    }
  })
  return 'stored'
}

/**
 * Insert a `files` row (if there is none) only while the storage fence still
 * holds; FenceError when it doesn't, so the caller redoes its write.
 */
export async function recordFile(
  db: Db,
  f: { hash: string; size: number; mimeType: string; storageKey: string },
  fence: number,
): Promise<void> {
  const lit = <T>(v: unknown) => sql<T>`${v}`
  const now = Date.now()
  await db
    .insert(schema.files)
    .select(
      db
        .select({
          hash: lit<string>(f.hash).as('hash'),
          size: lit<number>(f.size).as('size'),
          mimeType: lit<string>(f.mimeType).as('mime_type'),
          storageKey: lit<string>(f.storageKey).as('storage_key'),
          verifiedAt: lit<number>(now).as('verified_at'),
          createdAt: lit<number>(now).as('created_at'),
        })
        .from(schema.storageFence)
        .where(fenceHolds(fence)) as never,
    )
    .onConflictDoNothing()
  if (await fenceMoved(db, fence)) throw new FenceError()
}

export interface UploadTicket {
  id: string
  url?: string
  /** Multipart: every part but the last is partBytes long. */
  partBytes?: number
  partCount?: number
  /** The first PARTS_PAGE parts; GET …/uploads/:id/parts?from=n for the rest. */
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
    ticket.partBytes = partBytesFor(req.size)
    ticket.partCount = Math.ceil(req.size / ticket.partBytes)
    ticket.parts = await presignParts(
      ports,
      { storageKey: key, multipartUploadId, size: req.size },
      1,
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

  // The write phase: from here a deletion window means doing it again (the
  // staging object stays until the upload is verified, so it can).
  const verified = await fenced(ports.db, async (fence) => {
    const [existing] = await ports.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, u.hash))
      .limit(1)
    if (!existing) {
      const storageKey = ports.stores.canonicalFileKey(u.hash)
      // With the size, a store copies past CopyObject's 5 GiB in parts (UploadPartCopy).
      await copyObject(blobs, u.storageKey, storageKey, size)
      await recordFile(ports.db, { hash: u.hash, size, mimeType: u.mimeType, storageKey }, fence)
    }
    const done = await ports.db
      .update(schema.fileUploads)
      .set({ status: 'verified' })
      .where(
        and(
          eq(schema.fileUploads.id, uploadId),
          eq(schema.fileUploads.status, 'verifying'),
          fenceHolds(fence),
        ),
      )
      .returning({ id: schema.fileUploads.id })
    if (done.length === 0 && (await fenceMoved(ports.db, fence))) throw new FenceError()
    return done.length === 1
  })
  if (verified) await blobs.delete(u.storageKey)
}

registerJob('files.verify', async (job, ports) => verifyUpload(ports, String(job.uploadId)))
