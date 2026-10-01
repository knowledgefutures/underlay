// @vitest-environment node
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createGunzip, createGzip } from 'node:zlib'

import { pack as tarPack, extract as tarExtract } from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { filterRecordData } from './core/privacy.js'
import {
  createExportArchive,
  type ExportArchiveSource,
  type ExportFileRow,
  type ExportManifest,
  type ExportRecordRow,
} from './export-archive.server.js'

// ── Seeded collection ────────────────────────────────────────────────────────

interface SeedRecord extends ExportRecordRow {
  private: boolean
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const id = (n: number) => `r${String(n).padStart(6, '0')}`

function fileBytes(seed: string, size: number): Buffer {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (seed.charCodeAt(i % seed.length) * 31 + i) & 0xff
  return buf
}

const FILES = {
  photo: { bytes: fileBytes('photo', 300_123) }, // several chunks
  empty: { bytes: Buffer.alloc(0) },
  nested: { bytes: fileBytes('nested', 777) },
  privateRecordOnly: { bytes: fileBytes('private-record', 1_000) },
  privateFieldOnly: { bytes: fileBytes('private-field', 2_000) },
  unreferenced: { bytes: fileBytes('unreferenced', 3_000) },
  missing: { bytes: null }, // in the files table, gone from the store
  noLength: { bytes: fileBytes('no-length', 4_096) }, // store omits ContentLength
}
type FileKey = keyof typeof FILES
const hashOf = (k: FileKey) => sha(k)
const fileRef = (k: FileKey) => ({ $file: `sha256:${hashOf(k)}` })

function seedRecords(): Map<string, SeedRecord[]> {
  const byType = new Map<string, SeedRecord[]>()
  const add = (type: string, n: number, data: unknown, isPrivate = false) => {
    if (!byType.has(type)) byType.set(type, [])
    byType.get(type)!.push({ recordId: id(n), type, data, private: isPrivate })
  }

  for (let i = 0; i < 120; i++) {
    add('Article', i, {
      title: `Article ${i} — naïve café ☕`,
      email: `author${i}@example.org`,
      ...(i === 3 && { cover: fileRef('photo') }),
      ...(i === 4 && { body: [{ figure: { image: fileRef('nested') } }] }),
      ...(i === 5 && { email: fileRef('privateFieldOnly') }),
      ...(i === 6 && { attachment: fileRef('empty') }),
      ...(i === 7 && { attachment: fileRef('missing') }),
      ...(i === 8 && { attachment: fileRef('noLength') }),
    })
  }
  add('Article', 200, { title: 'hidden', attachment: fileRef('privateRecordOnly') }, true)
  add('Article', 201, { title: 'also hidden' }, true)

  // Over two parts, exactly one part, and a type that is entirely private records.
  for (let i = 0; i < 60_123; i++) add('Big', i, { n: i, s: i % 7 === 0 ? '𝄞' : 'x' })
  for (let i = 0; i < 25_000; i++) add('Exact', i, { n: i })
  for (let i = 0; i < 10; i++) add('Hidden', i, { n: i }, true)
  for (let i = 0; i < 5; i++) add('Secret', i, { token: `t${i}` })

  return byType
}

const RECORDS = seedRecords()
// Deliberately not alphabetical: entries follow the order given.
const TYPES = ['Big', 'Article', 'Secret', 'Exact', 'Hidden']

function seededSource(
  ownerAccess: boolean,
  overrides: Partial<ExportArchiveSource> = {},
): ExportArchiveSource & { fetches: number } {
  const privateTypes = new Set(['Secret'])
  const privateFieldsByType = new Map([['Article', new Set(['email'])]])
  const manifest: ExportManifest = {
    collection: { owner: 'acme', slug: 'things', name: 'Things', description: null },
    version: {
      semver: '1.2.0',
      hash: 'versionhash',
      message: 'seed',
      recordCount: 999_999,
      fileCount: 99,
      totalBytes: 9_999_999,
      createdAt: new Date('2026-09-01T12:00:00Z'),
    },
    schemas: { Article: { type: 'object' } },
    files_missing: [],
  }
  const files: ExportFileRow[] = (Object.keys(FILES) as FileKey[]).map((k) => ({
    hash: hashOf(k),
    size: FILES[k].bytes?.length ?? 0,
    storageKey: `files/${k}`,
  }))

  const source = {
    fetches: 0,
    manifest,
    types: TYPES,
    files,
    ownerAccess,
    privateTypes,
    privateFieldsByType,
    async fetchRecords(type: string, after: string | null, limit: number) {
      source.fetches++
      return (RECORDS.get(type) ?? [])
        .filter((r) => ownerAccess || !r.private)
        .filter((r) => after === null || r.recordId > after)
        .slice(0, limit)
        .map(({ recordId, type, data }) => ({ recordId, type, data }))
    },
    async openFile(file: ExportFileRow) {
      const key = file.storageKey.replace('files/', '') as FileKey
      const bytes = FILES[key].bytes
      if (!bytes) throw new Error('NoSuchKey')
      const chunks: Buffer[] = []
      for (let i = 0; i < bytes.length; i += 16_384) chunks.push(bytes.subarray(i, i + 16_384))
      return { body: Readable.from(chunks), size: key === 'noLength' ? undefined : bytes.length }
    },
    ...overrides,
  }
  return source
}

// ── The export as it was built before streaming ──────────────────────────────
// A frozen copy of the buffered implementation from src/api/collections.ts
// (commit c2a4ede), reading the same source. The new stream must match it
// byte for byte.

async function legacyExport(source: ExportArchiveSource): Promise<Buffer> {
  const { manifest, ownerAccess, privateTypes, privateFieldsByType } = source
  const pack = tarPack()
  const gzip = createGzip()
  const RECORDS_PER_PART = 25_000

  let emittedRecordCount = 0
  const referencedFileHashes = new Set<string>()
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

  for (const type of source.types) {
    if (!ownerAccess && privateTypes.has(type)) continue
    const privateFields = privateFieldsByType.get(type) ?? new Set<string>()
    let batchCursor: string | null = null
    let batchHasMore = true
    let partIndex = 0
    let pending: string[] = []

    const flushPart = (isFinalPart: boolean) => {
      if (pending.length === 0) return
      const name =
        partIndex === 0 && isFinalPart
          ? `records/${type}.ndjson`
          : `records/${type}.${String(partIndex).padStart(4, '0')}.ndjson`
      const buf = Buffer.from(pending.join('\n') + '\n')
      pack.entry({ name, size: buf.length }, buf)
      pending = []
      partIndex++
    }

    while (batchHasMore) {
      const batch = await source.fetchRecords(type, batchCursor, 5001)
      batchHasMore = batch.length > 5000
      const page = batchHasMore ? batch.slice(0, 5000) : batch
      if (page.length > 0) batchCursor = page[page.length - 1]!.recordId
      for (const r of page) {
        const data =
          !ownerAccess && privateFields.size > 0 ? filterRecordData(r.data, privateFields) : r.data
        if (!ownerAccess) collectFileRefs(data)
        emittedRecordCount++
        pending.push(JSON.stringify({ id: r.recordId, type: r.type, data }))
      }
      if (pending.length >= RECORDS_PER_PART) flushPart(false)
    }
    flushPart(true)
  }

  let emittedFileCount = 0
  let emittedFileBytes = 0
  for (const file of source.files) {
    if (!ownerAccess && !referencedFileHashes.has(file.hash)) continue
    try {
      const { body } = await source.openFile(file)
      const fileBuffer = await collect(body)
      pack.entry({ name: `files/${file.hash}`, size: fileBuffer.length }, fileBuffer)
      emittedFileCount++
      emittedFileBytes += fileBuffer.length
    } catch {
      manifest.files_missing.push(file.hash)
    }
  }

  if (!ownerAccess) {
    manifest.version.recordCount = emittedRecordCount
    manifest.version.fileCount = emittedFileCount
    manifest.version.totalBytes = emittedFileBytes
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2))
  pack.entry({ name: 'manifest.json', size: manifestBuf.length }, manifestBuf)
  pack.finalize()
  return collect(pack.pipe(gzip))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function listEntries(gz: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>()
  const extract = tarExtract()
  Readable.from([gz]).pipe(createGunzip()).pipe(extract)
  for await (const entry of extract) entries.set(entry.header.name, await collect(entry))
  return entries
}

async function exportTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) => n.startsWith('underlay-export-'))
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

// tar headers carry an mtime of "now", so freeze the clock to compare bytes.
// The seeded missing file is logged on every export; keep that out of the output.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-01T09:30:00Z'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createExportArchive', () => {
  it.each([
    ['owner', true],
    ['non-owner', false],
  ])('is byte-identical to the buffered export (%s)', async (_label, ownerAccess) => {
    const legacySource = seededSource(ownerAccess)
    const streamedSource = seededSource(ownerAccess)
    const expected = await legacyExport(legacySource)
    const actual = await collect(createExportArchive(streamedSource))

    expect(actual.length).toBe(expected.length)
    expect(actual.equals(expected)).toBe(true)
    expect(streamedSource.manifest).toEqual(legacySource.manifest)
  })

  it('lays out records and files as documented', async () => {
    const entries = await listEntries(await collect(createExportArchive(seededSource(false))))

    expect([...entries.keys()]).toEqual([
      'records/Big.0000.ndjson',
      'records/Big.0001.ndjson',
      'records/Big.0002.ndjson',
      'records/Article.ndjson',
      'records/Exact.0000.ndjson',
      `files/${hashOf('photo')}`,
      `files/${hashOf('empty')}`,
      `files/${hashOf('nested')}`,
      `files/${hashOf('noLength')}`,
      'manifest.json',
    ])
    const lines = (name: string) => entries.get(name)!.toString().trimEnd().split('\n')
    expect(lines('records/Big.0000.ndjson')).toHaveLength(25_000)
    expect(lines('records/Big.0002.ndjson')).toHaveLength(10_123)
    expect(lines('records/Exact.0000.ndjson')).toHaveLength(25_000)

    const articles = lines('records/Article.ndjson').map((l) => JSON.parse(l))
    expect(articles).toHaveLength(120)
    expect(articles.some((a) => 'email' in a.data)).toBe(false)
    expect(entries.get(`files/${hashOf('photo')}`)!.equals(FILES.photo.bytes)).toBe(true)

    const manifest = JSON.parse(entries.get('manifest.json')!.toString())
    expect(manifest.files_missing).toEqual([hashOf('missing')])
    expect(manifest.version.recordCount).toBe(60_123 + 120 + 25_000)
    expect(manifest.version.fileCount).toBe(4)
    expect(manifest.version.totalBytes).toBe(300_123 + 0 + 777 + 4_096)
  })

  it('produces the archive as it is read, not ahead of the reader', async () => {
    const source = seededSource(true)
    const archive = createExportArchive(source)
    const reader = archive[Symbol.asyncIterator]()

    const first = await reader.next()
    expect(first.done).toBe(false)
    await tick()
    // Big alone is 13 pages; without a reader the producer must stall early.
    const fetchedWhileStalled = source.fetches
    expect(fetchedWhileStalled).toBeLessThan(13)
    await tick()
    expect(source.fetches).toBe(fetchedWhileStalled)

    await reader.return?.()
  })

  it('stops reading and cleans up when the consumer goes away', async () => {
    const before = await exportTempDirs()
    const source = seededSource(true)
    const archive = createExportArchive(source)
    for await (const _chunk of archive) break // destroys the stream
    await tick()
    const fetched = source.fetches
    await tick()
    expect(source.fetches).toBe(fetched)
    expect(await exportTempDirs()).toEqual(before)
  })

  it('aborts the download when a file body fails mid-stream', async () => {
    const source = seededSource(true, {
      async openFile(file) {
        async function* failing() {
          yield Buffer.alloc(100)
          throw new Error('connection reset')
        }
        return { body: Readable.from(failing()), size: file.size }
      },
    })
    await expect(collect(createExportArchive(source))).rejects.toThrow('connection reset')
  })

  it('aborts the download when a file body is shorter than its size', async () => {
    const source = seededSource(true, {
      async openFile(file) {
        return { body: Readable.from([Buffer.alloc(10)]), size: file.size + 1 }
      },
    })
    await expect(collect(createExportArchive(source))).rejects.toThrow()
  })
})
