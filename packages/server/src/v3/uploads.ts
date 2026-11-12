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
 */
import {
  checkSchemaFull,
  compileSchema,
  createObject,
  hashSchema,
  MAX_JSON_DEPTH,
  parseStrict,
  type SchemaValidator,
  v3,
} from '@underlay/protocol'
import { and, count, eq, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { type CommitStats, headView, schemasOf, syncCatalog, viewOf } from './catalog.js'
import { copyAssetFromUpload } from './commit.js'
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
  /** An upload idle longer than this expires; its objects are cleared by the sweep. */
  idleMs: 24 * 60 * 60 * 1000,
  /** Open uploads a user may hold. */
  open: 20,
  /** Files one commit may name. */
  files: 10_000,
  /** A file up to this size goes up in one presigned PUT; larger, in equal parts. */
  singlePutBytes: 64 * 1024 * 1024,
  partBytes: v3.PART_BYTES,
  /** S3's limit for one object. */
  maxFileBytes: 5 * 1024 ** 4,
  presignSeconds: 3600,
  /** Times a land is tried again after other commits landed first. */
  landAttempts: 5,
}

const HEX64 = /^[0-9a-f]{64}$/
export type UploadRow = typeof schema.v3Uploads.$inferSelect

export const uploadObjectKey = (upload: string, fileId: string) => v3.uploadKey(upload, fileId)
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
    .where(and(eq(schema.v3Uploads.userId, userId), eq(schema.v3Uploads.status, 'open')))) as [
    { n: number },
  ]
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

export async function completeFile(
  ports: Ports,
  upload: UploadRow,
  fileId: string,
  multipartId: string,
  parts: { n: number; etag: string }[],
) {
  const presigner = ports.stores.v3.presigner!
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

/** A commit's request, checked; null and the problem when it cannot be taken. */
export function checkCommitBody(body: Record<string, unknown>): { files: v3.FileRef[] } | string {
  const files = body.files
  if (!Array.isArray(files) || files.length === 0) return '"files" must be a non-empty list'
  if (files.length > uploadLimits.files) return `At most ${uploadLimits.files} files a commit`
  for (const f of files as v3.FileRef[]) {
    if (!f || typeof f !== 'object' || !HEX64.test(String(f.id))) return 'Each file needs its id'
    for (const k of ['entries', 'records', 'removals', 'bytes'] as const)
      if (!Number.isSafeInteger(f[k]) || f[k] < 0) return `File ${f.id}: "${k}" must be a count`
  }
  return { files: files as v3.FileRef[] }
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
  await setUpload(ports, id, null, {
    status: 'open',
    error,
    expiresAt: new Date(Date.now() + uploadLimits.idleMs),
  })
}

async function fail(ports: Ports, id: string, error: NonNullable<UploadRow['error']>) {
  await setUpload(ports, id, null, { status: 'failed', error })
}

const dec = new TextDecoder()
const dataOf = (line: Uint8Array) =>
  (parseStrict(dec.decode(line), MAX_JSON_DEPTH + 1) as { data: unknown }).data

/** Every entry of one type in a set of the upload's files, with what reads its line. */
async function* typeEntries(ports: Ports, upload: string, files: v3.FileRef[], type: string) {
  const store = ports.stores.v3
  for (const f of files) {
    if (!f.first || !f.last) continue
    if (v3.compareKeys(f.first[0], '', type, '') > 0 || v3.compareKeys(type, '', f.last[0], '') > 0)
      continue
    const file = await v3.SortedFile.open(store, uploadObjectKey(upload, f.id), { id: f.id })
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

registerJob('v3.uploadPrepare', async (job, ports) => {
  const upload = await getUpload(ports, String(job.uploadId))
  if (!upload || upload.status !== 'verifying') return
  const store = ports.stores.v3
  const cid = upload.collectionId
  const files = (upload.files ?? []) as v3.FileRef[]
  // Every named file came with this upload.
  const present = new Set(await presentFiles(ports, upload.id))
  const absent = files.filter((f) => !present.has(f.id)).map((f) => f.id)
  if (absent.length > 0) {
    await reopen(ports, upload.id, {
      statusCode: 422,
      error: 'Files not uploaded',
      problems: absent.slice(0, 100),
    })
    return
  }
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
  const schemas: Record<string, unknown> = await schemasOf(store, view)
  const problems: string[] = []
  for await (const { entry, line } of typeEntries(ports, upload.id, files, v3.SCHEMA_TYPE)) {
    if (entry.kind === 'x') {
      delete schemas[entry.id]
      continue
    }
    const body = dataOf(await line())
    const err = checkSchemaFull(entry.id, body)
    if (err) problems.push(err)
    schemas[entry.id] = body
  }
  const priv = privateMarkError(
    collection.public,
    schemas as Record<string, Record<string, unknown>>,
  )
  if (priv) problems.push(priv)
  if (problems.length > 0) {
    await fail(ports, upload.id, { statusCode: 422, error: 'Schemas refused', problems })
    return
  }
  // Assets the upload names: in the v3 area, or uploaded to this collection and copied in.
  const missing: string[] = []
  for await (const { entry } of typeEntries(ports, upload.id, files, v3.ASSET_TYPE)) {
    if (entry.kind !== 'r' || (await store.head(assetKey(entry.id)))) continue
    if (!(await copyAssetFromUpload(ports, cid, entry.id))) missing.push(entry.id)
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
    const scanUpload = { files, session: upload.id }
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
  await setUpload(ports, upload.id, 'verifying', {
    schemas,
    expectHead: head?.id ?? null,
    verified: 0,
    scanUnits: scanUnitCount,
    scanDone: scanUnitCount === 0,
  })
  await ports.jobs.enqueueBatch(
    files.map((f) => ({
      type: 'v3.uploadVerify',
      uploadId: upload.id,
      fileId: f.id,
      head: head?.id ?? null,
    })),
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
  // Verified already against this head (a job delivered twice): counted then.
  if (await internal.head(marker)) return
  // Structure, canonical lines, and each record against the schemas in force.
  const schemas = (upload.schemas ?? {}) as Record<string, unknown>
  const validators = new Map<string, SchemaValidator>()
  const problems: string[] = []
  const onRecord = (type: string, id: string, data: unknown) => {
    if (problems.length >= 20) return
    if (type === v3.SCHEMA_TYPE || type === v3.META_TYPE || type === v3.ASSET_TYPE) return
    const s = schemas[type]
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
      await v3.verifyFile(store, uploadObjectKey(upload.id, fileId), {
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
  // What the file's rows change in the head: one lookup a row, in key order.
  const view = upload.expectHead
    ? await headViewAt(ports, upload.collectionId, upload.expectHead)
    : null
  const stats = await fileStats(ports, upload.id, fileId, view)
  // Only the job that writes the marker counts the file.
  const fresh = await createObject(
    internal,
    marker,
    JSON.stringify({ head: upload.expectHead, stats } satisfies FileStats),
  )
  if (fresh) await countVerified(ports, upload)
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
  upload: string,
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
  const file = await v3.SortedFile.open(store, uploadObjectKey(upload, fileId), { id: fileId })
  const reader = file.reader({ readAhead: 4 * 1024 * 1024 })
  const cursor = new v3.EntryCursor(reader, 1)
  const read: v3.ReadOptions = { cache: new v3.FileCache(16 * 1024 * 1024), readers: new Map() }
  await cursor.seek()
  while (cursor.current) {
    const e = cursor.current
    const [newest] = view ? await v3.history(store, view, e.type, e.id, read) : []
    const before = !newest || newest.kind === 'x' ? null : { hash: newest.hash!, size: newest.size }
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
    await cursor.next()
  }
  return s
}

/** Count a verified file, then land if that was the last thing waited on. */
async function countVerified(ports: Ports, upload: UploadRow) {
  await ports.db
    .update(schema.v3Uploads)
    .set({ verified: sql`${schema.v3Uploads.verified} + 1`, updatedAt: new Date() })
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

registerJob('v3.uploadLand', async (job, ports) => {
  const upload = await getUpload(ports, String(job.uploadId))
  if (!upload || upload.status !== 'landing') return
  const internal = ports.stores.internal
  const files = (upload.files ?? []) as v3.FileRef[]
  const stats: CommitStats = {
    typeDelta: {},
    recordBytesDelta: 0,
    assetsDelta: 0,
    assetBytesDelta: 0,
    changes: { added: 0, removed: 0, updated: 0 },
  }
  for (const f of files) {
    const obj = await internal.get(markerKey(upload.id, upload.expectHead, f.id))
    const m = obj ? (JSON.parse(await obj.text()) as FileStats) : null
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
  // Which types' schemas the upload sets, for schema_usage: the head's against the upload's.
  const store = ports.stores.v3
  const headSchemas = upload.expectHead
    ? await schemasOf(store, await headViewAt(ports, cid, upload.expectHead))
    : {}
  const now = (upload.schemas ?? {}) as Record<string, unknown>
  const schemaChanges: [string, string | null][] = []
  for (const [t, body] of Object.entries(now)) {
    const h = hashSchema(body)
    if (!headSchemas[t] || hashSchema(headSchemas[t]) !== h) schemaChanges.push([t, h])
  }
  for (const t of Object.keys(headSchemas)) if (!(t in now)) schemaChanges.push([t, null])
  const metaRow = typeEntries(ports, upload.id, files, v3.META_TYPE)
  let metadata: Record<string, unknown> | null = null
  for await (const { entry, line } of metaRow) {
    if (entry.kind === 'r') metadata = dataOf(await line()) as Record<string, unknown>
  }
  const landed = await commitsOf(ports).land(ports, {
    collectionId: cid,
    session: upload.id,
    change,
    expectHead: upload.expectHead,
    stats,
    schemaChanges,
    metadata,
    pushedBy: upload.userId,
    appId: upload.appId,
    actorId: null,
    pushSessionId: null,
  })
  if (landed.status === 'committed') {
    const [v] = await ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, landed.versionId))
    await setUpload(ports, upload.id, 'landing', {
      status: 'committed',
      result: {
        semver: v?.semver,
        hash: v?.hash,
        recordCount: v?.recordCount,
        fileCount: v?.fileCount,
        changes: v?.changes,
      },
    })
    await clearMarkers(ports, upload.id)
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
    await setUpload(ports, upload.id, 'landing', {
      status: 'verifying',
      attempts: upload.attempts + 1,
    })
  )
    await ports.jobs.enqueue({ type: 'v3.uploadPrepare', uploadId: upload.id })
})

/** Delete an upload's verification markers (every head's). */
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

/** Uploads past their idle time are expired; the sweep clears their objects. */
export async function expireUploads(ports: Ports) {
  await ports.db
    .update(schema.v3Uploads)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(eq(schema.v3Uploads.status, 'open'), sql`${schema.v3Uploads.expiresAt} < ${Date.now()}`),
    )
}
