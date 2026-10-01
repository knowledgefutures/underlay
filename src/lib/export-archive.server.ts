// Builds a collection export (.tar.gz) as a stream. The archive is produced
// while the client reads it: nothing waits for the whole tarball, and memory
// stays at one record batch plus stream buffers regardless of collection size.
//
// Where the bytes come from (database, S3) is injected, so the archive layout
// can be tested without either. The layout is a contract — the same version
// must export to the same bytes — so change it deliberately.

import { createReadStream } from 'node:fs'
import { type FileHandle, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'

import { type Headers, type Pack, pack as tarPack } from 'tar-stream'

import { filterRecordData } from './core/privacy.js'

/** Records per `records/<Type>…ndjson` entry before a type splits into parts. */
export const RECORDS_PER_PART = 25_000
/** Records fetched per query. */
export const RECORD_BATCH = 5_000

export interface ExportRecordRow {
  recordId: string
  type: string
  data: unknown
}

export interface ExportFileRow {
  hash: string
  /** Byte size from the files table; used when the object store doesn't report one. */
  size: number
  storageKey: string
}

export interface ExportManifest {
  collection: { owner: string; slug: string; name: string; description: string | null }
  version: {
    semver: string
    hash: string
    message: string | null
    recordCount: number
    fileCount: number
    totalBytes: number
    createdAt: Date
  }
  schemas: Record<string, unknown>
  files_missing: string[]
}

export interface ExportArchiveSource {
  /**
   * Written last, so it can report what the archive actually contains. For
   * non-owners its counts and `files_missing` are filled in while streaming.
   */
  manifest: ExportManifest
  /** Record types in the order their entries are written. */
  types: string[]
  /** Version files in the order their entries are written. */
  files: ExportFileRow[]
  ownerAccess: boolean
  privateTypes: ReadonlySet<string>
  privateFieldsByType: ReadonlyMap<string, Set<string>>
  /**
   * Up to `limit` records of `type`, ordered by record id, strictly after
   * `after` (from the start when null). Non-owner callers must already exclude
   * records flagged private.
   */
  fetchRecords(type: string, after: string | null, limit: number): Promise<ExportRecordRow[]>
  /**
   * Open a file's body. A throw here (missing object, store unreachable) lists
   * the file in `files_missing` and the export continues. `size` is the
   * object's byte length when the store reports it.
   */
  openFile(file: ExportFileRow): Promise<{ body: Readable; size?: number | undefined }>
}

/**
 * Start producing the export and return the gzipped tar stream. Production
 * follows the reader: each entry is written only as fast as the consumer
 * drains it, so a slow client throttles the database and S3 reads.
 *
 * Errors after the first byte cannot become a status code. They destroy the
 * returned stream, so the client sees a truncated download rather than a
 * well-formed archive with something silently missing.
 */
export function createExportArchive(source: ExportArchiveSource): Readable {
  const pack = tarPack()
  const gzip = createGzip()
  pack.pipe(gzip)
  // A pack failure is reported by destroying gzip, the stream the caller holds.
  pack.on('error', () => {})

  // The consumer going away (client disconnect cancels the response stream,
  // which destroys gzip) has to stop the producer, which may be parked
  // waiting for a drain that will never come.
  let finished = false
  let cancelled = false
  gzip.once('close', () => {
    if (finished) return
    cancelled = true
    pack.destroy(new Error('export cancelled'))
  })

  writeArchive(pack, source, () => cancelled).then(
    () => {
      finished = true
      pack.finalize()
    },
    (err) => {
      finished = true
      if (cancelled) return
      console.error('[export] Archive aborted:', err)
      pack.destroy(err)
      gzip.destroy(err)
    },
  )

  return gzip
}

async function writeArchive(
  pack: Pack,
  source: ExportArchiveSource,
  isCancelled: () => boolean,
): Promise<void> {
  const { manifest, ownerAccess } = source

  // tar needs each entry's byte length in its header, before its body. A
  // record part's length isn't known until its last record is serialized, so
  // each part is spooled to a temp file first and then streamed into the tar.
  const dir = await mkdtemp(join(tmpdir(), 'underlay-export-'))
  try {
    const { emittedRecordCount, referencedFileHashes } = await writeRecords(
      pack,
      source,
      join(dir, 'part.ndjson'),
      isCancelled,
    )

    let emittedFileCount = 0
    let emittedFileBytes = 0
    for (const file of source.files) {
      // For non-owners, only files referenced by the (privacy-filtered) records
      // that actually ship may be included — a file attached solely to a
      // private record or private field must not leak.
      if (!ownerAccess && !referencedFileHashes.has(file.hash)) continue
      if (isCancelled()) throw new Error('export cancelled')
      let opened: { body: Readable; size?: number | undefined }
      try {
        opened = await source.openFile(file)
      } catch (err) {
        console.error(`[export] Failed to download file ${file.hash} (${file.storageKey}):`, err)
        manifest.files_missing.push(file.hash)
        continue
      }
      // Past this point the entry header is written, so a body that fails or
      // comes up short aborts the archive (see createExportArchive).
      const size = opened.size ?? file.size
      await writeStreamEntry(pack, { name: `files/${file.hash}`, size }, opened.body)
      emittedFileCount++
      emittedFileBytes += size
    }

    // Report what the archive actually contains, so a non-owner's manifest
    // matches its payload instead of the owner's (larger) totals.
    if (!ownerAccess) {
      manifest.version.recordCount = emittedRecordCount
      manifest.version.fileCount = emittedFileCount
      manifest.version.totalBytes = emittedFileBytes
    }

    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2))
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: 'manifest.json', size: manifestBuf.length }, manifestBuf, (err) =>
        err ? reject(err) : resolve(),
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Each type is emitted in bounded parts. A type that fits in one part keeps
// the plain `records/<Type>.ndjson` name; a larger one splits into
// `records/<Type>.0000.ndjson`, `.0001.ndjson`, … of RECORDS_PER_PART records
// each. A type of exactly RECORDS_PER_PART records is `.0000` — the part is
// named when it fills, before the end of the type is known.
async function writeRecords(
  pack: Pack,
  source: ExportArchiveSource,
  partPath: string,
  isCancelled: () => boolean,
): Promise<{ emittedRecordCount: number; referencedFileHashes: Set<string> }> {
  const { ownerAccess } = source
  let emittedRecordCount = 0
  const referencedFileHashes = new Set<string>()
  // Walks nested objects and arrays: `$file` refs are not restricted to the
  // top level (nothing in schema validation forbids nesting), and a missed
  // ref would silently drop a legitimately-public file from the archive.
  const collectFileRefs = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const ref = (value as { $file?: unknown }).$file
    if (typeof ref === 'string') {
      referencedFileHashes.add(ref.replace('sha256:', ''))
      return
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectFileRefs(child)
    }
  }

  const part = new PartFile(partPath)
  try {
    for (const type of source.types) {
      // Non-owners never see private types.
      if (!ownerAccess && source.privateTypes.has(type)) continue
      const privateFields = source.privateFieldsByType.get(type) ?? new Set<string>()
      let partIndex = 0
      let cursor: string | null = null
      let hasMore = true

      while (hasMore) {
        if (isCancelled()) throw new Error('export cancelled')
        const batch = await source.fetchRecords(type, cursor, RECORD_BATCH + 1)
        hasMore = batch.length > RECORD_BATCH
        const page = hasMore ? batch.slice(0, RECORD_BATCH) : batch
        if (page.length > 0) cursor = page[page.length - 1]!.recordId

        let out = ''
        for (const r of page) {
          const data =
            !ownerAccess && privateFields.size > 0
              ? filterRecordData(r.data, privateFields)
              : r.data
          if (!ownerAccess) collectFileRefs(data)
          emittedRecordCount++
          out += JSON.stringify({ id: r.recordId, type: r.type, data }) + '\n'
          part.records++
          if (part.records === RECORDS_PER_PART) {
            await part.append(out)
            out = ''
            await part.emit(pack, `records/${type}.${String(partIndex).padStart(4, '0')}.ndjson`)
            partIndex++
          }
        }
        if (out) await part.append(out)
      }

      if (part.records > 0) {
        const name =
          partIndex === 0
            ? `records/${type}.ndjson`
            : `records/${type}.${String(partIndex).padStart(4, '0')}.ndjson`
        await part.emit(pack, name)
      }
    }
  } finally {
    await part.close()
  }

  return { emittedRecordCount, referencedFileHashes }
}

/** The record part being spooled to disk, and its running record and byte counts. */
class PartFile {
  records = 0
  private bytes = 0
  private handle: FileHandle | null = null

  constructor(private readonly path: string) {}

  async append(lines: string): Promise<void> {
    this.handle ??= await open(this.path, 'w')
    const buf = Buffer.from(lines)
    await this.handle.appendFile(buf)
    this.bytes += buf.length
  }

  /** Stream the spooled part into the tar as `name`, then start a fresh part. */
  async emit(pack: Pack, name: string): Promise<void> {
    await this.close()
    await writeStreamEntry(pack, { name, size: this.bytes }, createReadStream(this.path))
    this.records = 0
    this.bytes = 0
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    await handle?.close()
  }
}

/**
 * Write one tar entry from a stream, waiting on the tar's backpressure between
 * chunks. Resolves once the entry is complete; rejects if the body fails, its
 * length doesn't match `header.size`, or the archive is torn down.
 */
async function writeStreamEntry(
  pack: Pack,
  header: Headers,
  body: AsyncIterable<Uint8Array>,
): Promise<void> {
  let sink: ReturnType<Pack['entry']>
  const done = new Promise<void>((resolve, reject) => {
    sink = pack.entry(header, (err) => (err ? reject(err) : resolve()))
  })
  // Failures arrive through the entry callback (`done`). Without a listener
  // the sink's 'error' event (e.g. a size mismatch) would be an uncaught
  // exception, and `done` can reject while we're between awaits.
  sink!.on('error', () => {})
  done.catch(() => {})
  try {
    for await (const chunk of body) {
      if (!sink!.write(chunk)) {
        await Promise.race([new Promise((resolve) => sink!.once('drain', resolve)), done])
      }
    }
    sink!.end()
  } catch (err) {
    sink!.destroy(err as Error)
    throw err
  }
  await done
}
