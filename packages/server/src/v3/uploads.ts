/**
 * Uploads a client builds (v3-deploy-plan.md, Phase 2): the client sorts its rows and
 * writes sorted-record-files itself with the library, sends each straight to the bucket by
 * presigned URL under `v3/uploads/<upload>/<file id>`, and commits a change that names
 * them. Nothing passes through a Worker but the commit's own small objects.
 *
 * The commit is a chain of jobs on the bulk queue:
 *
 *   v3.uploadPrepare   the schemas in force (the head's, with the upload's `$schema` rows
 *                      over them), its assets in place, its files' key ranges apart; then
 *                      a verify job for each file
 *   v3.uploadVerify    one file: its structure, canonical lines, and every record against
 *                      its schema (`verifyFile`); and what its rows change in the head the
 *                      upload is prepared against (before-states), for the version's counts
 *   v3.uploadLand      once every file is verified: the change lands through the
 *                      collection's commit queue. If another commit landed first, the
 *                      counts are made again against the new head, a few times at most.
 *
 * Section 4.3: a file is named only if its bytes came with this upload (they are under its
 * prefix), and they are checked against its id here. A file already stored is not enough.
 *
 * The client can write `uploads/<upload>/<file id>` for as long as its presigned URLs last,
 * so a commit first copies each named file into a session of the server's own (`stage`),
 * which no presigned URL names, and everything after reads that copy: the bytes checked are
 * the bytes installed, whatever the client sends meanwhile.
 */
import {
  checkSchemaFull,
  compileSchema,
  copyObject,
  createObject,
  hashSchema,
  InputRuleError,
  jcs,
  MAX_JSON_DEPTH,
  parseStrict,
  type SchemaValidator,
  v3,
} from '@underlay/protocol'
import { and, count, eq, inArray, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob, runJob } from '../jobs.js'
import type { JobMessage, Ports } from '../ports.js'
import { type CommitStats, headView, schemasOf, syncCatalog, viewOf } from './catalog.js'
import { copyAssetFromUpload } from './commit.js'
import { fanOut } from './fanout.js'
import { commitsOf } from './queue.js'
import { assetKey, privateMarkError } from './rules.js'
import {
  scanConfig,
  scanFinished,
  scanInline,
  scanUnits,
  startScan,
  tightenedTypes,
} from './scans.js'

export const uploadLimits = {
  /**
   * A commit naming at most this many files and bytes is verified and landed in the request
   * that asks for it (`inlineUpload`), not by queued jobs: for a small upload the queue
   * hops are most of the time.
   */
  inlineFiles: 8,
  inlineBytes: 32 * 1024 * 1024,
  /**
   * An upload open this long without a commit expires, and a commit not finished this long
   * after it was asked for fails. The sweep clears an upload's objects a day after each was
   * written, so a file sent more than a day before its commit must be sent again.
   */
  idleMs: 24 * 60 * 60 * 1000,
  /** Uploads a user may hold that are open or being committed. */
  open: 20,
  /** Files one commit may name. */
  files: 10_000,
  /** A file up to this size goes up in one presigned PUT; larger, in equal parts. */
  singlePutBytes: 64 * 1024 * 1024,
  partBytes: v3.PART_BYTES,
  /**
   * The largest file taken: 512 parts. A sorted-record-file is cut toward 128 MB stored, and
   * one far past this could not be verified within a job's CPU limit.
   */
  maxFileBytes: 4 * 1024 ** 3,
  /** A commit's message and base, in characters. */
  messageChars: 64 * 1024,
  presignSeconds: 3600,
  /** Times a land is tried again after other commits landed first. */
  landAttempts: 5,
}

const HEX64 = /^[0-9a-f]{64}$/
export type UploadRow = typeof schema.v3Uploads.$inferSelect

export const uploadObjectKey = (upload: string, fileId: string) => v3.uploadKey(upload, fileId)

/** Which session of the server's own a commit's files were copied into, to be checked there. */
const stageKey = (upload: string) => `v3-uploads/${upload}/stage.json`

/** The session an upload's files are checked and installed from, or null before they are taken. */
async function stageOf(ports: Ports, upload: string): Promise<string | null> {
  const obj = await ports.stores.internal.get(stageKey(upload))
  return obj ? (JSON.parse(await obj.text()) as { session: string }).session : null
}

/**
 * Take a commit's files out of the client's reach: copy each from where the client sent it
 * into a new session only this job writes, then name that session for the upload, created
 * only if absent. Of two jobs preparing one upload at once, both use the session of the one
 * that named its first, so a file there is written once and never changes. Returns the
 * session, or the files the client has not sent.
 */
async function stageFiles(
  ports: Ports,
  upload: string,
  files: v3.FileRef[],
): Promise<{ session: string } | { absent: string[] }> {
  const store = ports.stores.v3
  const staged = await stageOf(ports, upload)
  if (staged) return { session: staged }
  const present = new Set(await presentFiles(ports, upload))
  const absent = files.filter((f) => !present.has(f.id)).map((f) => f.id)
  if (absent.length > 0) return { absent }
  const session = v3.newSession()
  await v3.inParallel(
    files.map(
      (f) => () => copyObject(store, uploadObjectKey(upload, f.id), v3.uploadKey(session, f.id)),
    ),
    16,
  )
  await createObject(ports.stores.internal, stageKey(upload), JSON.stringify({ session }))
  return { session: (await stageOf(ports, upload)) ?? session }
}
/** What prepare found that landing needs, against one head. */
interface Prepared {
  schemaChanges: [string, string | null][]
  metadata: Record<string, unknown> | null
  bump: 'major' | 'minor' | 'patch'
}
/** Beside the markers, not among them: `countVerified` counts what is under the head's folder. */
const preparedKey = (upload: string, head: string | null) =>
  `v3-uploads/${upload}/prepared-${head ?? 'none'}.json`

/** A verified file's counts against one head: written once, by the job that verified it. */
const markerKey = (upload: string, head: string | null, fileId: string) =>
  `v3-uploads/${upload}/${head ?? 'none'}/${fileId}.json`

export async function getUpload(ports: Ports, id: string): Promise<UploadRow | null> {
  const [row] = await ports.db.select().from(schema.v3Uploads).where(eq(schema.v3Uploads.id, id))
  return row ?? null
}

async function setUpload(
  ports: Ports,
  id: string,
  from: UploadRow['status'] | null,
  set: Partial<typeof schema.v3Uploads.$inferInsert>,
): Promise<boolean> {
  const rows = await ports.db
    .update(schema.v3Uploads)
    .set({ ...set, updatedAt: new Date() })
    .where(
      from === null
        ? eq(schema.v3Uploads.id, id)
        : and(eq(schema.v3Uploads.id, id), eq(schema.v3Uploads.status, from)),
    )
    .returning({ id: schema.v3Uploads.id })
  return rows.length > 0
}

/** An upload not yet settled: open, or somewhere in its commit. */
const IN_FLIGHT: UploadRow['status'][] = ['open', 'verifying', 'landing', 'committing']

/** Open an upload for a user on a v3 collection; null when the user holds too many. */
export async function openUpload(
  ports: Ports,
  collectionId: string,
  userId: string,
  body: { message?: string | null; base?: string | null; appId?: string | null },
): Promise<UploadRow | null> {
  const [{ n }] = (await ports.db
    .select({ n: count() })
    .from(schema.v3Uploads)
    .where(
      and(eq(schema.v3Uploads.userId, userId), inArray(schema.v3Uploads.status, IN_FLIGHT)),
    )) as [{ n: number }]
  if (n >= uploadLimits.open) return null
  const [row] = await ports.db
    .insert(schema.v3Uploads)
    .values({
      collectionId,
      userId,
      message: body.message ?? null,
      base: body.base ?? null,
      appId: body.appId ?? null,
      expiresAt: new Date(Date.now() + uploadLimits.idleMs),
    })
    .returning()
  return row!
}

/** Where a client sends one file: a presigned PUT, or equal parts of a multipart upload. */
export async function presignFile(ports: Ports, upload: UploadRow, fileId: string, size: number) {
  const store = ports.stores.v3
  const key = uploadObjectKey(upload.id, fileId)
  const presigner = store.presigner
  if (!presigner) throw new Error('The v3 area cannot presign')
  if (size <= uploadLimits.singlePutBytes) {
    return {
      method: 'PUT' as const,
      url: await presigner.presignPut(key, { expiresIn: uploadLimits.presignSeconds }),
    }
  }
  const multipartId = await presigner.createMultipart(key)
  const n = Math.ceil(size / uploadLimits.partBytes)
  const parts = []
  for (let i = 1; i <= n; i++) {
    parts.push({
      n: i,
      url: await presigner.presignPart(key, multipartId, i, uploadLimits.presignSeconds),
    })
  }
  return {
    method: 'multipart' as const,
    upload_id: multipartId,
    part_bytes: uploadLimits.partBytes,
    parts,
  }
}

/** A multipart completion's parts, checked: numbered 1 up, an ETag each; or what is wrong. */
export function checkParts(parts: unknown): { n: number; etag: string }[] | string {
  const most = Math.ceil(uploadLimits.maxFileBytes / uploadLimits.partBytes)
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > most)
    return `"parts" must list 1 to ${most} parts`
  const out: { n: number; etag: string }[] = []
  for (const p of parts as { n?: unknown; etag?: unknown }[]) {
    if (!p || !Number.isInteger(p.n) || (p.n as number) < 1 || (p.n as number) > most)
      return 'Each part needs its number "n"'
    if (typeof p.etag !== 'string' || p.etag.length === 0 || p.etag.length > 256)
      return `Part ${p.n} needs its "etag"`
    out.push({ n: p.n as number, etag: p.etag })
  }
  return out
}

export async function completeFile(
  ports: Ports,
  upload: UploadRow,
  fileId: string,
  multipartId: string,
  parts: { n: number; etag: string }[],
) {
  const presigner = ports.stores.v3.presigner
  if (!presigner) throw new Error('The v3 area cannot presign')
  await presigner.completeMultipart(
    uploadObjectKey(upload.id, fileId),
    multipartId,
    parts.map((p) => ({ partNumber: p.n, etag: p.etag })),
  )
}

/** The files of an upload that are in the bucket (for a client taking an upload up again). */
export async function presentFiles(ports: Ports, uploadId: string): Promise<string[]> {
  const out: string[] = []
  const prefix = `uploads/${uploadId}/`
  let cursor: string | undefined
  do {
    const page = await ports.stores.v3.list(prefix, cursor)
    out.push(...page.keys.map((k) => k.slice(prefix.length)))
    cursor = page.cursor
  } while (cursor)
  return out
}

/** The jobs of an upload's commit, which `inlineUpload` runs in the request. */
const UPLOAD_JOBS: ReadonlySet<string> = new Set([
  'v3.uploadPrepare',
  'v3.uploadVerify',
  'v3.uploadLand',
])

/**
 * Ports that run an upload's own jobs here, one after another, when `drain` is called, and
 * send every other job (what follows a commit, a scan in units) to the real queues. The
 * same handlers, in the same order the queues would run them.
 */
export function inlineUpload(ports: Ports): { ports: Ports; drain(): Promise<void> } {
  const pending: JobMessage[] = []
  // No pool: the upload's own jobs run here, one after another.
  const { pool: _pool, ...rest } = ports
  const inline: Ports = {
    ...rest,
    jobs: {
      async enqueue(job, opts) {
        if (UPLOAD_JOBS.has(job.type) && !opts?.delaySeconds) pending.push(job)
        else await ports.jobs.enqueue(job, opts)
      },
      async enqueueBatch(jobs) {
        pending.push(...jobs.filter((j) => UPLOAD_JOBS.has(j.type)))
        const rest = jobs.filter((j) => !UPLOAD_JOBS.has(j.type))
        if (rest.length > 0) await ports.jobs.enqueueBatch(rest)
      },
    },
  }
  return {
    ports: inline,
    async drain() {
      const took: string[] = []
      for (let job = pending.shift(); job; job = pending.shift()) {
        const t0 = Date.now()
        await runJob(job, inline)
        took.push(`${job.type.replace('v3.upload', '')} ${Date.now() - t0}ms`)
      }
      console.log(`[v3.upload] inline: ${took.join(', ')}`)
    },
  }
}

/** Whether a commit is small enough to verify and land in its request. */
export async function smallCommit(ports: Ports, uploadId: string, files: v3.FileRef[]) {
  if (files.length > uploadLimits.inlineFiles) return false
  let bytes = 0
  for (const f of files) {
    const h = await ports.stores.v3.head(uploadObjectKey(uploadId, f.id))
    if (!h) return false
    bytes += h.size
  }
  return bytes <= uploadLimits.inlineBytes
}

const isKeyPair = (k: unknown): k is v3.KeyPair =>
  Array.isArray(k) && k.length === 2 && typeof k[0] === 'string' && typeof k[1] === 'string'

/**
 * A commit's request, checked: its files as a commit names them (nothing else a client
 * sent with them is kept), each named once; or the problem when it cannot be taken.
 */
export function checkCommitBody(body: Record<string, unknown>): { files: v3.FileRef[] } | string {
  const files = body.files
  if (!Array.isArray(files) || files.length === 0) return '"files" must be a non-empty list'
  if (files.length > uploadLimits.files) return `At most ${uploadLimits.files} files a commit`
  const out: v3.FileRef[] = []
  const seen = new Set<string>()
  for (const f of files as v3.FileRef[]) {
    if (!f || typeof f !== 'object' || !HEX64.test(String(f.id))) return 'Each file needs its id'
    if (seen.has(f.id)) return `File ${f.id} is named twice`
    seen.add(f.id)
    for (const k of ['entries', 'records', 'removals', 'bytes'] as const)
      if (!Number.isSafeInteger(f[k]) || f[k] < 0) return `File ${f.id}: "${k}" must be a count`
    // A file with rows has its first and last keys; an empty one has neither.
    if (
      f.entries === 0
        ? f.first != null || f.last != null
        : !isKeyPair(f.first) || !isKeyPair(f.last)
    )
      return `File ${f.id}: "first" and "last" must be its first and last keys`
    out.push({
      id: f.id,
      first: f.first ?? null,
      last: f.last ?? null,
      entries: f.entries,
      records: f.records,
      removals: f.removals,
      bytes: f.bytes,
    })
  }
  return { files: out }
}

/**
 * A change the client sent with its commit, checked: for this collection, naming the same
 * files, and unsigned. The server keeps no authors' keys (the pusher is recorded in D1), so
 * it has nothing to check a signature against, and a commit must not carry a key id nobody
 * verified. Gives the change as it will be committed, or the problem.
 */
export function checkChange(
  change: unknown,
  collectionId: string,
  files: v3.FileRef[],
): v3.Change | string {
  const c = change as Partial<v3.Change> | null
  if (!c || typeof c !== 'object' || Array.isArray(c)) return '"change" must be an object'
  if (c.collection !== collectionId || !Array.isArray(c.files) || jcs(c.files) !== jcs(files))
    return '"change" must be for this collection and name the same files'
  for (const k of ['base', 'message'] as const) {
    const v = c[k] ?? null
    if (v !== null && (typeof v !== 'string' || v.length > uploadLimits.messageChars))
      return `"change.${k}" must be a string or null`
  }
  if ((c.keyId ?? null) !== null || (c.sig ?? null) !== null)
    return 'A signed change is not accepted yet: send it unsigned ("keyId" and "sig" null)'
  return {
    collection: collectionId,
    files,
    base: c.base ?? null,
    message: c.message ?? null,
    keyId: null,
    sig: null,
  }
}

/** Start verifying a commit's files. The upload must be open. */
export async function requestCommit(
  ports: Ports,
  upload: UploadRow,
  files: v3.FileRef[],
  change: v3.Change | null,
): Promise<boolean> {
  const ok = await setUpload(ports, upload.id, 'open', {
    status: 'verifying',
    files,
    change: change as never,
    verified: 0,
    attempts: 0,
    error: null,
    expiresAt: new Date(Date.now() + uploadLimits.idleMs),
  })
  if (ok) await ports.jobs.enqueue({ type: 'v3.uploadPrepare', uploadId: upload.id })
  return ok
}

/** A failure the client can fix in the same upload (missing files): it goes back to open. */
async function reopen(ports: Ports, id: string, error: NonNullable<UploadRow['error']>) {
  // The next commit may name other files: it takes its own copies.
  await ports.stores.internal.delete(stageKey(id))
  await setUpload(ports, id, null, {
    status: 'open',
    error,
    expiresAt: new Date(Date.now() + uploadLimits.idleMs),
  })
}

async function fail(ports: Ports, id: string, error: NonNullable<UploadRow['error']>) {
  await setUpload(ports, id, null, { status: 'failed', error })
  await clearMarkers(ports, id)
}

const dec = new TextDecoder()
const dataOf = (line: Uint8Array) =>
  (parseStrict(dec.decode(line), MAX_JSON_DEPTH + 1) as { data: unknown }).data

/** Every entry of one type in a set of the upload's files (in `session`), with what reads its line. */
async function* typeEntries(ports: Ports, session: string, files: v3.FileRef[], type: string) {
  const store = ports.stores.v3
  for (const f of files) {
    if (!f.first || !f.last) continue
    if (v3.compareKeys(f.first[0], '', type, '') > 0 || v3.compareKeys(type, '', f.last[0], '') > 0)
      continue
    const file = await v3.SortedFile.open(store, v3.uploadKey(session, f.id), { id: f.id })
    const reader = file.reader({ readAhead: 1024 * 1024 })
    const cursor = new v3.EntryCursor(reader, 1)
    await cursor.seek({ type, id: '' })
    while (cursor.current && cursor.current.type === type) {
      const e = cursor.current
      yield { entry: e, line: () => reader.line(e) }
      await cursor.next()
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The reserved rows of an upload's files: each `$schema` row (null for a removal), each
 * `$asset` row it adds, and its `$meta` row's data. Found by the key ranges the commit gives
 * for its files, which each file's verification holds it to.
 */
async function reservedRows(ports: Ports, session: string, files: v3.FileRef[]) {
  const schemas: [string, unknown | null][] = []
  for await (const { entry, line } of typeEntries(ports, session, files, v3.SCHEMA_TYPE))
    schemas.push([entry.id, entry.kind === 'x' ? null : dataOf(await line())])
  const assets: [string, unknown][] = []
  for await (const { entry, line } of typeEntries(ports, session, files, v3.ASSET_TYPE))
    if (entry.kind === 'r') assets.push([entry.id, dataOf(await line())])
  let metadata: unknown = null
  for await (const { entry, line } of typeEntries(ports, session, files, v3.META_TYPE))
    if (entry.kind === 'r') metadata = dataOf(await line())
  return { schemas, assets, metadata }
}

registerJob('v3.uploadPrepare', async (job, ports) => {
  const t0 = Date.now()
  const upload = await getUpload(ports, String(job.uploadId))
  if (!upload || upload.status !== 'verifying') return
  const store = ports.stores.v3
  const cid = upload.collectionId
  const files = (upload.files ?? []) as v3.FileRef[]
  // Every named file came with this upload, and is checked from the server's own copy.
  const stage = await stageFiles(ports, upload.id, files)
  if ('absent' in stage) {
    await reopen(ports, upload.id, {
      statusCode: 422,
      error: 'Files not uploaded',
      problems: stage.absent.slice(0, 100),
    })
    return
  }
  const session = stage.session
  // Key ranges apart, as a commit requires.
  const sorted = files
    .filter((f) => f.first)
    .sort((a, b) => v3.compareKeys(a.first![0], a.first![1], b.first![0], b.first![1]))
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!.last!
    const b = sorted[i]!.first!
    if (v3.compareKeys(a[0], a[1], b[0], b[1]) >= 0) {
      await fail(ports, upload.id, {
        statusCode: 422,
        error: `Files ${sorted[i - 1]!.id} and ${sorted[i]!.id} overlap`,
      })
      return
    }
  }
  const [collection] = await ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, cid))
  if (!collection) return
  await syncCatalog(ports, cid)
  const head = await v3.findHead(store, cid)
  const view = head ? await headView(store, cid) : null
  // The schemas in force: the head's, with the upload's `$schema` rows over them.
  const headSchemas: Record<string, unknown> = await schemasOf(store, view)
  const schemas: Record<string, unknown> = { ...headSchemas }
  const problems: string[] = []
  // The upload's reserved rows are read before its files are verified (the verify jobs need
  // the schemas): a file too broken to read them from fails the upload here.
  let reserved: Awaited<ReturnType<typeof reservedRows>>
  try {
    reserved = await reservedRows(ports, session, files)
  } catch (err) {
    if (!(err instanceof v3.FormatError || err instanceof InputRuleError)) throw err
    await fail(ports, upload.id, {
      statusCode: 422,
      error: 'A file is not valid',
      problems: [err.message],
    })
    return
  }
  for (const [type, body] of reserved.schemas) {
    if (body === null) {
      if (Object.hasOwn(schemas, type)) delete schemas[type]
      continue
    }
    const err = v3.checkKey(v3.SCHEMA_TYPE, type) ?? checkSchemaFull(type, body)
    if (err) problems.push(err)
    else schemas[type] = body
  }
  const priv = privateMarkError(
    collection.public,
    schemas as Record<string, Record<string, unknown>>,
  )
  if (priv) problems.push(priv)
  if (reserved.metadata !== null && !isObject(reserved.metadata))
    problems.push('$meta data must be an object')
  if (problems.length > 0) {
    await fail(ports, upload.id, { statusCode: 422, error: 'Schemas refused', problems })
    return
  }
  // Assets the upload names. A new one must have been uploaded to this collection through
  // the file routes (the push's test, and v2's): knowing a hash is not holding its bytes, and
  // another collection's asset must not become readable here by being named. Its bytes are
  // copied into the v3 area, and the row must give their size.
  const missing: string[] = []
  const read: v3.ReadOptions = { cache: new v3.FileCache(16 * 1024 * 1024) }
  for (const [hash, data] of reserved.assets) {
    const shape = v3.checkAssetData(data)
    if (shape) {
      problems.push(`$asset ${hash}: ${shape}`)
      continue
    }
    const named = view && (await v3.getRecord(store, view, v3.ASSET_TYPE, hash, read))?.line
    if (!named && !(await copyAssetFromUpload(ports, cid, hash))) {
      missing.push(hash)
      continue
    }
    const stored = await store.head(assetKey(hash))
    if (!stored) missing.push(hash)
    else if (stored.size !== (data as { size: number }).size)
      problems.push(
        `$asset ${hash}: it is ${stored.size} bytes, not ${(data as { size: number }).size}`,
      )
  }
  if (problems.length > 0) {
    await fail(ports, upload.id, { statusCode: 422, error: 'Assets refused', problems })
    return
  }
  if (missing.length > 0) {
    await reopen(ports, upload.id, {
      statusCode: 422,
      error: 'Missing files',
      problems: missing.slice(0, 100),
    })
    return
  }
  // Records the head carries over under a tightened schema: scanned here, or in units
  // alongside the files' verification.
  let scanUnitCount = 0
  const tight = await tightenedTypes(ports, view, schemas)
  if (view && tight.length > 0) {
    const scanUpload = { files, session }
    const units = await scanUnits(ports, view, tight)
    const [row] = await ports.db
      .select({ typeCounts: schema.versions.typeCounts })
      .from(schema.versions)
      .where(and(eq(schema.versions.collectionId, cid), eq(schema.versions.hash, head!.id)))
    const records = tight.reduce((n, t) => n + (row?.typeCounts[t.type] ?? 0), 0)
    if (records <= scanConfig.inlineRecords) {
      const found = await scanInline(ports, view, scanUpload, units)
      if (found.length > 0) {
        await fail(ports, upload.id, {
          statusCode: 422,
          error: 'Records refused by the new schema',
          problems: found,
        })
        return
      }
    } else {
      scanUnitCount = units.length
      await startScan(ports, {
        id: `upload-${upload.id}-${upload.attempts}`,
        collectionId: cid,
        version: view.version,
        upload: scanUpload,
        units,
        then: { kind: 'upload', uploadId: upload.id, head: head?.id ?? null },
      })
    }
  }
  // What landing needs and prepare knows: which schemas change, the metadata, the bump.
  const schemaChanges: [string, string | null][] = []
  for (const [t, body] of Object.entries(schemas)) {
    const h = hashSchema(body)
    if (!headSchemas[t] || hashSchema(headSchemas[t]) !== h) schemaChanges.push([t, h])
  }
  for (const t of Object.keys(headSchemas)) if (!(t in schemas)) schemaChanges.push([t, null])
  const metadata = reserved.metadata as Record<string, unknown> | null
  // A file holds publisher rows exactly when its first or last key's type is not reserved.
  const ordinary = files.some(
    (f) => (f.first && !f.first[0].startsWith('$')) || (f.last && !f.last[0].startsWith('$')),
  )
  const prepared: Prepared = {
    schemaChanges,
    metadata,
    bump: schemaChanges.length > 0 ? 'major' : ordinary ? 'minor' : 'patch',
  }
  await ports.stores.internal.put(
    preparedKey(upload.id, head?.id ?? null),
    JSON.stringify(prepared),
  )
  await setUpload(ports, upload.id, 'verifying', {
    schemas,
    expectHead: head?.id ?? null,
    verified: 0,
    scanUnits: scanUnitCount,
    scanDone: scanUnitCount === 0,
  })
  const t1 = Date.now()
  await fanOut(
    ports,
    files.map((f) => ({
      type: 'v3.uploadVerify',
      uploadId: upload.id,
      fileId: f.id,
      head: head?.id ?? null,
    })),
  )
  const t2 = Date.now()
  // With a pool the files are verified by now: land here, not a queue hop later. (The land
  // job queued when the last file was counted finds it claimed and stops.)
  if (ports.pool) await landUpload(ports, upload.id)
  console.log(
    `[v3.upload] ${upload.id}: ${files.length} files, prepare ${t1 - t0}ms, verify ${t2 - t1}ms` +
      (ports.pool ? `, land ${Date.now() - t2}ms` : ''),
  )
})

/** What one verified file changes in the head it was checked against. */
interface FileStats {
  head: string | null
  stats: CommitStats
}

registerJob('v3.uploadVerify', async (job, ports) => {
  const upload = await getUpload(ports, String(job.uploadId))
  if (!upload || upload.status !== 'verifying') return
  // A verify queued for an older head (a land that lost) has nothing to do.
  if ((job.head ?? null) !== upload.expectHead) return
  const store = ports.stores.v3
  const internal = ports.stores.internal
  const fileId = String(job.fileId)
  const f = ((upload.files ?? []) as v3.FileRef[]).find((x) => x.id === fileId)
  if (!f) return
  const marker = markerKey(upload.id, upload.expectHead, fileId)
  // Verified already against this head (a job delivered twice, or queued again): count it.
  if (await internal.head(marker)) return countVerified(ports, upload)
  // The copy prepare took, which the client cannot write.
  const session = await stageOf(ports, upload.id)
  if (!session) return
  // Structure, canonical lines, and each record against the schemas in force.
  const schemas = (upload.schemas ?? {}) as Record<string, unknown>
  const validators = new Map<string, SchemaValidator>()
  const problems: string[] = []
  const onRecord = (type: string, id: string, data: unknown) => {
    if (problems.length >= 20) return
    if (type === v3.SCHEMA_TYPE) return
    if (type === v3.META_TYPE) {
      if (!isObject(data)) problems.push('$meta data must be an object')
      return
    }
    if (type === v3.ASSET_TYPE) {
      const shape = v3.checkAssetData(data)
      if (shape) problems.push(`$asset ${id}: ${shape}`)
      return
    }
    const s = Object.hasOwn(schemas, type) ? schemas[type] : undefined
    if (!s) {
      problems.push(`Type "${type}" has records but no schema`)
      return
    }
    let v = validators.get(type)
    if (!v) validators.set(type, (v = compileSchema(s)))
    const errs = v(data)
    if (errs.length > 0) problems.push(`${type} ${JSON.stringify(id)}: ${errs[0]}`)
  }
  let content: v3.FileContent
  try {
    content = (
      await v3.verifyFile(store, v3.uploadKey(session, fileId), {
        id: fileId,
        labeled: false,
        canonical: true,
        onRecord,
      })
    ).content
  } catch (err) {
    await fail(ports, upload.id, {
      statusCode: 422,
      error: `File ${fileId} is not valid`,
      problems: [String((err as Error).message)],
    })
    return
  }
  if (
    content.entries !== f.entries ||
    content.records !== f.records ||
    content.removals !== f.removals ||
    content.bytes !== f.bytes ||
    JSON.stringify(content.first) !== JSON.stringify(f.first) ||
    JSON.stringify(content.last) !== JSON.stringify(f.last)
  ) {
    problems.push(`File ${fileId} is not as the commit describes it`)
  }
  if (problems.length > 0) {
    await fail(ports, upload.id, { statusCode: 422, error: 'Records refused', problems })
    return
  }
  // Checked: install it among the stored files now (a server-side copy), so landing finds
  // it there and does not copy hundreds of files inside the collection's queue. If the
  // upload never lands, nothing lists it and the sweep clears it after its grace period.
  await v3.installUpload(store, session, fileId)
  // What the file's rows change in the head: one lookup a row, in key order.
  const view = upload.expectHead
    ? await headViewAt(ports, upload.collectionId, upload.expectHead)
    : null
  const stats = await fileStats(ports, session, fileId, view)
  await createObject(
    internal,
    marker,
    JSON.stringify({ head: upload.expectHead, stats } satisfies FileStats),
  )
  await countVerified(ports, upload)
})

/** The view of the version with this id (a head the upload was prepared against). */
async function headViewAt(ports: Ports, collectionId: string, id: string) {
  const [row] = await ports.db
    .select({ seq: schema.versions.seq })
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.hash, id)))
  return row ? viewOf(ports.stores.v3, collectionId, row.seq) : null
}

async function fileStats(
  ports: Ports,
  session: string,
  fileId: string,
  view: v3.View | null,
): Promise<CommitStats> {
  const store = ports.stores.v3
  const s: CommitStats = {
    typeDelta: {},
    recordBytesDelta: 0,
    assetsDelta: 0,
    assetBytesDelta: 0,
    changes: { added: 0, removed: 0, updated: 0 },
  }
  const file = await v3.SortedFile.open(store, v3.uploadKey(session, fileId), { id: fileId })
  const reader = file.reader({ readAhead: 4 * 1024 * 1024 })
  const cursor = new v3.EntryCursor(reader, 1)
  const read: v3.ReadOptions = { cache: new v3.FileCache(16 * 1024 * 1024) }
  await cursor.seek()
  // The file's entries a chunk at a time, each chunk's keys looked up in the head at once.
  for (;;) {
    const chunk: v3.Entry[] = []
    while (cursor.current && chunk.length < 1024) {
      chunk.push(cursor.current)
      await cursor.next()
    }
    if (chunk.length === 0) break
    const befores = view ? await v3.statesAt(store, view, chunk, read) : []
    for (const [i, e] of chunk.entries()) await count(e, befores[i] ?? null)
  }
  return s

  async function count(e: v3.Entry, before: { hash: string; size: number } | null) {
    if (e.type === v3.ASSET_TYPE) {
      if (e.kind === 'r' && !before) {
        s.assetsDelta++
        s.assetBytesDelta += (dataOf(await reader.line(e)) as { size: number }).size
      } else if (e.kind === 'x' && before) {
        const rec = await v3.getRecord(store, view!, v3.ASSET_TYPE, e.id, read)
        s.assetsDelta--
        s.assetBytesDelta -= rec?.line ? (dataOf(rec.line) as { size: number }).size : 0
      }
    } else if (!e.type.startsWith('$')) {
      if (e.kind === 'x') {
        if (before) {
          s.typeDelta[e.type] = (s.typeDelta[e.type] ?? 0) - 1
          s.recordBytesDelta -= before.size
          s.changes.removed++
        }
      } else if (!before) {
        s.typeDelta[e.type] = (s.typeDelta[e.type] ?? 0) + 1
        s.recordBytesDelta += e.size
        s.changes.added++
      } else if (before.hash !== e.hash) {
        s.recordBytesDelta += e.size - before.size
        s.changes.updated++
      }
    }
  }
}

/** Count a verified file, then land if that was the last thing waited on. */
async function countVerified(ports: Ports, upload: UploadRow) {
  // The files verified are the markers written for this head: counted, not incremented, so
  // a job delivered twice, or a prepare queued again, never counts a file twice or loses one.
  let n = 0
  let cursor: string | undefined
  do {
    const page = await ports.stores.internal.list(
      `v3-uploads/${upload.id}/${upload.expectHead ?? 'none'}/`,
      cursor,
    )
    n += page.keys.length
    cursor = page.cursor
  } while (cursor)
  await ports.db
    .update(schema.v3Uploads)
    .set({ verified: sql`max(${schema.v3Uploads.verified}, ${n})`, updatedAt: new Date() })
    .where(and(eq(schema.v3Uploads.id, upload.id), eq(schema.v3Uploads.status, 'verifying')))
  await maybeLand(ports, upload.id)
}

/** Every file verified and the scan, if any, passed: move to landing (once) and queue it. */
async function maybeLand(ports: Ports, id: string) {
  const u = await getUpload(ports, id)
  if (!u || u.status !== 'verifying') return
  if (u.verified < ((u.files ?? []) as unknown[]).length || !u.scanDone) return
  if (await setUpload(ports, id, 'verifying', { status: 'landing' }))
    await ports.jobs.enqueue({ type: 'v3.uploadLand', uploadId: id })
}

/** An upload's scan in units finished: failed with what it found, or on toward landing. */
scanFinished.upload = async (ports, state, problems) => {
  if (state.then.kind !== 'upload') return
  const u = await getUpload(ports, state.then.uploadId)
  // A scan for an older head (a land that lost and was prepared again) is not this one's.
  if (!u || u.status !== 'verifying' || u.expectHead !== state.then.head) return
  if (problems.length > 0) {
    await fail(ports, u.id, {
      statusCode: 422,
      error: 'Records refused by the new schema',
      problems,
    })
    return
  }
  await setUpload(ports, u.id, 'verifying', { scanDone: true })
  await maybeLand(ports, u.id)
}

registerJob('v3.uploadLand', async (job, ports) => landUpload(ports, String(job.uploadId)))

/**
 * Land an upload whose files are all verified. The landing is claimed first (landing →
 * committing), so of two land jobs for one upload (the queue's, and prepare's own once its
 * fan-out is done) exactly one lands it.
 */
async function landUpload(ports: Ports, uploadId: string) {
  const upload = await getUpload(ports, uploadId)
  if (!upload || upload.status !== 'landing') return
  if (!(await setUpload(ports, upload.id, 'landing', { status: 'committing' }))) return
  const t0 = Date.now()
  const internal = ports.stores.internal
  const files = (upload.files ?? []) as v3.FileRef[]
  const stats: CommitStats = {
    typeDelta: {},
    recordBytesDelta: 0,
    assetsDelta: 0,
    assetBytesDelta: 0,
    changes: { added: 0, removed: 0, updated: 0 },
  }
  const markers = await v3.inParallel(
    files.map((f) => async () => {
      const obj = await internal.get(markerKey(upload.id, upload.expectHead, f.id))
      return obj ? (JSON.parse(await obj.text()) as FileStats) : null
    }),
    16,
  )
  for (const [i, f] of files.entries()) {
    const m = markers[i]
    if (!m || m.head !== upload.expectHead) {
      await fail(ports, upload.id, {
        statusCode: 500,
        error: `File ${f.id} has no verification for this head`,
      })
      return
    }
    for (const [t, d] of Object.entries(m.stats.typeDelta))
      stats.typeDelta[t] = (stats.typeDelta[t] ?? 0) + d
    stats.recordBytesDelta += m.stats.recordBytesDelta
    stats.assetsDelta += m.stats.assetsDelta
    stats.assetBytesDelta += m.stats.assetBytesDelta
    stats.changes.added += m.stats.changes.added
    stats.changes.removed += m.stats.changes.removed
    stats.changes.updated += m.stats.changes.updated
  }
  const cid = upload.collectionId
  const change =
    (upload.change as v3.Change | null) ??
    (await v3.makeChange(cid, { files, base: upload.base, message: upload.message }))
  const obj = await internal.get(preparedKey(upload.id, upload.expectHead))
  if (!obj) {
    await fail(ports, upload.id, {
      statusCode: 500,
      error: 'The prepared commit is gone; commit again',
    })
    return
  }
  const { schemaChanges, metadata, bump } = JSON.parse(await obj.text()) as Prepared
  const session = await stageOf(ports, upload.id)
  if (!session) {
    await fail(ports, upload.id, {
      statusCode: 500,
      error: 'The checked files are gone; commit again',
    })
    return
  }
  const t1 = Date.now()
  const landed = await commitsOf(ports).land(ports, {
    collectionId: cid,
    session,
    bump,
    change,
    expectHead: upload.expectHead,
    stats,
    schemaChanges,
    metadata,
    pushedBy: upload.userId,
    appId: upload.appId,
    actorId: null,
    // The version row names the upload: recovery finds a commit a land job made and lost.
    pushSessionId: upload.id,
  })
  const t2 = Date.now()
  if (landed.status === 'committed') {
    await settleCommitted(ports, upload.id, landed.versionId)
    console.log(
      `[v3.upload] ${upload.id} landed: markers ${t1 - t0}ms, commit ${t2 - t1}ms, settle ${Date.now() - t2}ms`,
    )
    return
  }
  if (landed.status === 'invalid') {
    await fail(ports, upload.id, {
      statusCode: 422,
      error: 'Commit refused',
      problems: landed.problems,
    })
    return
  }
  // Another commit landed first: the counts are made again against the new head.
  if (upload.attempts + 1 >= uploadLimits.landAttempts) {
    await fail(ports, upload.id, {
      statusCode: 409,
      error: 'Other commits kept landing first; commit again',
    })
    return
  }
  if (
    await setUpload(ports, upload.id, 'committing', {
      status: 'verifying',
      attempts: upload.attempts + 1,
    })
  )
    await ports.jobs.enqueue({ type: 'v3.uploadPrepare', uploadId: upload.id })
}

/** The upload landed as this version: record it as committed, and clear its markers. */
async function settleCommitted(ports: Ports, uploadId: string, versionId: string) {
  const [v] = await ports.db.select().from(schema.versions).where(eq(schema.versions.id, versionId))
  await setUpload(ports, uploadId, null, {
    status: 'committed',
    result: {
      semver: v?.semver,
      hash: v?.hash,
      recordCount: v?.recordCount,
      fileCount: v?.fileCount,
      changes: v?.changes,
    },
  })
  await clearMarkers(ports, uploadId)
  // What the client sent, now stored under its ids: cleared (the sweep would, a day on).
  const store = ports.stores.v3
  await v3.inParallel(
    (await presentFiles(ports, uploadId)).map(
      (id) => () => store.delete(uploadObjectKey(uploadId, id)),
    ),
    16,
  )
}

/** Delete what the internal area holds for an upload: its markers (every head's), and where its files were taken. */
async function clearMarkers(ports: Ports, upload: string) {
  const internal = ports.stores.internal
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await internal.list(`v3-uploads/${upload}/`, cursor)
    keys.push(...page.keys)
    cursor = page.cursor
  } while (cursor)
  await v3.inParallel(
    keys.map((k) => () => internal.delete(k)),
    8,
  )
}

/** A commit whose chain has gone quiet this long is queued again from where it stands. */
export const UPLOAD_STALL_MS = 15 * 60 * 1000

/**
 * Uploads stuck verifying or landing (a job lost, or never sent): queued again. Every step
 * is safe to run twice: prepare recounts the files already verified for the head, a verify
 * finds its marker, and a land that finds the head moved prepares again.
 */
export async function recoverUploads(ports: Ports) {
  const stuck = await ports.db
    .select({
      id: schema.v3Uploads.id,
      status: schema.v3Uploads.status,
      expiresAt: schema.v3Uploads.expiresAt,
    })
    .from(schema.v3Uploads)
    .where(
      and(
        sql`${schema.v3Uploads.status} IN ('verifying', 'landing', 'committing')`,
        sql`${schema.v3Uploads.updatedAt} < ${Date.now() - UPLOAD_STALL_MS}`,
      ),
    )
    .limit(50)
  for (const u of stuck) {
    // A land that stopped after committing: its version names the upload.
    const [v] =
      u.status === 'committing'
        ? await ports.db
            .select({ id: schema.versions.id })
            .from(schema.versions)
            .where(eq(schema.versions.pushSessionId, u.id))
            .limit(1)
        : []
    if (v) {
      await settleCommitted(ports, u.id, v.id)
      continue
    }
    // A commit that has not finished a day after it was asked for never will (a file no job
    // can get through): it fails, and stops being queued again.
    if (u.expiresAt.getTime() < Date.now()) {
      await fail(ports, u.id, {
        statusCode: 500,
        error: 'The commit did not finish in time; open a new upload',
      })
      continue
    }
    if (u.status === 'committing') {
      await setUpload(ports, u.id, 'committing', { status: 'landing' })
      await ports.jobs.enqueue({ type: 'v3.uploadLand', uploadId: u.id })
      continue
    }
    await setUpload(ports, u.id, u.status, {})
    await ports.jobs.enqueue({
      type: u.status === 'landing' ? 'v3.uploadLand' : 'v3.uploadPrepare',
      uploadId: u.id,
    })
  }
  return stuck.length
}

/** Abandon an open upload; false if it is not open. The sweep clears its objects. */
export const abandonUpload = (ports: Ports, id: string) =>
  setUpload(ports, id, 'open', { status: 'expired' })

/**
 * Open uploads not committed a day after they were opened (or last reopened) are expired.
 * The sweep clears an upload's objects a day after each was written, whatever its state.
 */
export async function expireUploads(ports: Ports) {
  await ports.db
    .update(schema.v3Uploads)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(eq(schema.v3Uploads.status, 'open'), sql`${schema.v3Uploads.expiresAt} < ${Date.now()}`),
    )
}
