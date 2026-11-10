/**
 * Jobs a scenario hands to child processes, each under the bench's heap cap:
 * parts of a parallel build, of a server's verification, of an export, and
 * slices of the many-collections and racing runs.
 *
 * A worker reads its spec from stdin and prints a report as its last line.
 */
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'

import { compileSchema, fileStore, parseStrict, v3 } from '../../packages/protocol/src/index.js'
import { hash32, idOf, prng, record, schemas, typeOf, Workload } from '../src/gen.js'
import { V3Engine } from './engine.js'
import { clientTarget, log, readSpec, refOf, report } from './lib.js'
import { BenchStore } from './store.js'
import { dayRows, rowOf, schemaRows } from './world.js'

type KeyPair = [string, string]
const inRange = (type: string, id: string, lo: KeyPair | null, hi: KeyPair | null): boolean =>
  (lo === null || v3.compareKeys(lo[0], lo[1], type, id) <= 0) &&
  (hi === null || v3.compareKeys(type, id, hi[0], hi[1]) < 0)

// --- A part of a parallel build from the generator ---

export interface BuildGenSpec {
  /** The upload session the built files go into. */
  session: string
  storeDir: string
  scratchDir: string
  latency: string
  seed: number
  records: number
  /** This part's key range: from `lo` up to, not including, `hi`. */
  lo: KeyPair | null
  hi: KeyPair | null
  schemas: boolean
  fileBytes: number
  level?: number
}

async function buildGen(): Promise<void> {
  const s = await readSpec<BuildGenSpec>()
  const store = new BenchStore(s.storeDir, s.latency)
  let made = 0
  function* rows(): Generator<v3.LineRow> {
    if (s.schemas) yield* schemaRows()
    for (let i = 0; i < s.records; i++) {
      // The key is cheap to work out; the record is built only if it falls in this part.
      if (!inRange(typeOf(s.seed, i), idOf(s.seed, i), s.lo, s.hi)) continue
      made++
      yield rowOf(record(s.seed, i, 0))
    }
  }
  const sorted = v3.sortRows(rows(), fileStore(s.scratchDir))
  const files = await v3.buildFiles(sorted, clientTarget(store, s.session), {
    maxBytes: s.fileBytes,
    ...(s.level === undefined ? {} : { level: s.level }),
  })
  report(store, {
    records: made,
    files: files.map(refOf),
    lineBytes: files.reduce((n, f) => n + f.bytes, 0),
    storedBytes: files.reduce((n, f) => n + f.size, 0),
  })
}

// --- A part of a parallel build from the sorted Crossref dump ---

export interface BuildDumpSpec {
  session: string
  storeDir: string
  latency: string
  dataDir: string
  /** Dump files, in key order: this part reads files [start, end). */
  files: string[]
  start: number
  end: number
  /** Add the schema rows (the first part only). */
  schemaTypes: string[] | null
  fileBytes: number
  level?: number
}

/** Lines of a gzipped NDJSON file, streamed. */
export async function* gzLines(path: string): AsyncGenerator<string> {
  let rest: Buffer | null = null
  const stream = createReadStream(path, { highWaterMark: 1 << 20 }).pipe(
    createGunzip({ chunkSize: 1 << 20 }),
  )
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf: Buffer = rest ? Buffer.concat([rest, chunk]) : chunk
    let start = 0
    for (;;) {
      const nl = buf.indexOf(10, start)
      if (nl < 0) break
      if (nl > start) yield buf.toString('utf8', start, nl)
      start = nl + 1
    }
    rest = start < buf.length ? buf.subarray(start) : null
  }
  if (rest && rest.length) yield rest.toString('utf8')
}

/** A Crossref work line as a row: the id is the DOI in lower case, the type the work's type. */
export function crossrefRow(line: string): v3.LineRow {
  const data = parseStrict(line) as { DOI: string; type: string }
  return v3.rowFromRecord(data.DOI.toLowerCase(), data.type, data)
}

/** The schema every Crossref type gets in the bench: light, so validation runs on every record. */
export const crossrefSchema = {
  type: 'object',
  required: ['DOI', 'type'],
  properties: { DOI: { type: 'string' }, type: { type: 'string' } },
}

async function buildDump(): Promise<void> {
  const s = await readSpec<BuildDumpSpec>()
  const store = new BenchStore(s.storeDir, s.latency)
  let records = 0
  let duplicates = 0
  let lineBytes = 0
  async function* rows(): AsyncGenerator<v3.LineRow> {
    if (s.schemaTypes) {
      for (const type of [...s.schemaTypes].sort((a, b) => v3.compareKeys(a, '', b, ''))) {
        yield v3.rowFromRecord(type, v3.SCHEMA_TYPE, crossrefSchema)
      }
    }
    // The dump holds a few keys twice, in neighbouring lines or files: the first is kept.
    let last: v3.LineRow | null = null
    if (s.start > 0) {
      for await (const line of gzLines(join(s.dataDir, s.files[s.start - 1]!)))
        last = crossrefRow(line)
    }
    for (let i = s.start; i < s.end; i++) {
      for await (const line of gzLines(join(s.dataDir, s.files[i]!))) {
        const row = crossrefRow(line)
        if (last && last.type === row.type && last.id === row.id) {
          duplicates++
          continue
        }
        last = row
        records++
        lineBytes += row.line.length
        yield row
      }
      if ((i - s.start) % 200 === 199)
        log(`build-dump ${s.start}: ${i - s.start + 1}/${s.end - s.start} files`)
    }
  }
  const files = await v3.buildFiles(rows(), clientTarget(store, s.session), {
    maxBytes: s.fileBytes,
    ...(s.level === undefined ? {} : { level: s.level }),
  })
  report(store, {
    records,
    duplicates,
    files: files.map(refOf),
    lineBytes: files.reduce((n, f) => n + f.bytes, 0),
    storedBytes: files.reduce((n, f) => n + f.size, 0),
  })
}

// --- A part of a server's verification of an upload ---

export interface VerifySpec {
  /** The upload session the files are checked in, before they are installed. */
  session: string
  storeDir: string
  latency: string
  files: v3.FileRef[]
  /** The schema each type's records must satisfy. */
  schemas: Record<string, unknown>
}

async function verify(): Promise<void> {
  const s = await readSpec<VerifySpec>()
  const store = new BenchStore(s.storeDir, s.latency)
  const validators = new Map(Object.entries(s.schemas).map(([t, body]) => [t, compileSchema(body)]))
  let records = 0
  let entries = 0
  let lineBytes = 0
  let done = 0
  const problems: string[] = []
  for (const f of s.files) {
    const v = await v3.verifyFile(store, v3.uploadKey(s.session, f.id), {
      id: f.id,
      labeled: false,
      canonical: true,
      onRecord: (type, id, data) => {
        if (type.startsWith('$')) return
        records++
        const validate = validators.get(type)
        if (!validate) problems.push(`Type "${type}" has no schema`)
        else {
          const errors = validate(data)
          if (errors.length > 0 && problems.length < 20)
            problems.push(`${type} ${id}: ${errors[0]}`)
        }
      },
    })
    entries += v.content.entries
    lineBytes += v.content.bytes
    if (++done % 25 === 0) log(`verify: ${done}/${s.files.length} files, ${records} records`)
  }
  report(store, { files: s.files.length, entries, records, lineBytes, problems })
}

// --- A part of an export ---

export interface ExportSpec {
  storeDir: string
  latency: string
  collection: string
  version: number
  from: KeyPair | null
  to: KeyPair | null
}

async function exportPart(): Promise<void> {
  const s = await readSpec<ExportSpec>()
  const store = new BenchStore(s.storeDir, s.latency)
  const engine = new V3Engine(store)
  const h = await engine.open(s.collection, s.version)
  const out = await engine.exportAll(h, {
    ...(s.from ? { from: { type: s.from[0], id: s.from[1] } } : {}),
    ...(s.to ? { to: { type: s.to[0], id: s.to[1] } } : {}),
  })
  report(store, out)
}

// --- A slice of many small collections ---

export interface ManySpec {
  storeDir: string
  scratchDir: string
  latency: string
  /** Collections [from, to), by number. */
  from: number
  to: number
  /** What to do to each: create and load it, or commit one more day to it. */
  phase: 'load' | 'day'
  day: number
  /** The median size of a collection's first load, in records. */
  records: number
  rate: number
  /** Collections worked on at once in this process. */
  streams: number
  tiers: v3.TierOptions
  maintain: boolean
}

export const manyId = (n: number) => `m${String(n).padStart(6, '0')}`
const manySeed = (n: number) => hash32(`many/${n}`)

/**
 * Records in a collection's first load: most are small and a few are large, as
 * the layout F run's were (half under 10 records, one in twenty over 75, the
 * largest 20,000). `scale` is the median.
 */
export function manySize(n: number, scale: number): number {
  const u = prng(hash32(`many-size/${n}`))()
  return Math.min(20_000, Math.max(1, Math.round((scale / 1.8) * (1 / (1 - u)) ** 0.85)))
}

async function many(): Promise<void> {
  const s = await readSpec<ManySpec>()
  const store = new BenchStore(s.storeDir, s.latency)
  const engine = new V3Engine(store, { tiers: s.tiers, scratch: fileStore(s.scratchDir), level: 1 })
  const commitMs: number[] = []
  const commitRequests: number[] = []
  let failed = 0
  let merges = 0
  let written = 0
  let next = s.from
  const one = async (n: number) => {
    const id = manyId(n)
    const seed = manySeed(n)
    const wl = new Workload(seed, manySize(n, s.records))
    let rows: Iterable<v3.LineRow>
    if (s.phase === 'load') {
      await v3.createCollection(store, id)
      rows = (function* () {
        yield* schemaRows()
        for (const r of wl.initial()) yield rowOf(r)
      })()
    } else {
      // Replay earlier days so this day's changes follow from them.
      for (let d = 1; d < s.day; d++) wl.day(d, s.rate)
      rows = dayRows(wl, s.day, s.rate)
    }
    const before = store.snapshot()
    const t0 = performance.now()
    await engine.commit(id, rows)
    commitMs.push(performance.now() - t0)
    const after = store.snapshot()
    commitRequests.push(after.classA - before.classA + after.classB - before.classB)
    if (s.maintain) {
      const m = await engine.maintain(id)
      merges += m.merges
      written += m.written
    }
  }
  await Promise.all(
    Array.from({ length: s.streams }, async () => {
      while (next < s.to) {
        const n = next++
        try {
          await one(n)
        } catch (err) {
          failed++
          console.error(`many: ${manyId(n)} failed: ${(err as Error).message}`)
        }
      }
    }),
  )
  report(store, { commits: commitMs.length, failed, commitMs, commitRequests, merges, written })
}

// --- Writers racing for one collection ---

export interface RaceSpec {
  storeDir: string
  latency: string
  collection: string
  writer: number
  /** Committers in this process, and commits each makes. */
  streams: number
  commits: number
}

async function race(): Promise<void> {
  const s = await readSpec<RaceSpec>()
  const store = new BenchStore(s.storeDir, s.latency)
  const r = prng(hash32(`race/${s.writer}`))
  const made: { number: number; file: string }[] = []
  const ms: number[] = []
  await Promise.all(
    Array.from({ length: s.streams }, async (_, stream) => {
      for (let c = 0; c < s.commits; c++) {
        // Each upload is a few records no other writer sends.
        const rows = Array.from({ length: 5 }, (_, k) =>
          v3.rowFromRecord(`w${s.writer}-${stream}-${c}-${k}`, 'journal-article', {
            DOI: `w${s.writer}-${stream}-${c}-${k}`,
            type: 'journal-article',
            title: ['race'],
            publisher: 'p',
            issued: {},
            n: Math.floor(r() * 1e9),
          }),
        ).sort(v3.compareKey)
        const session = v3.newSession()
        const files = await v3.buildFiles(rows, clientTarget(store, session), { level: 1 })
        const t0 = performance.now()
        // The whole server path, raced: check the upload, install it, claim a number.
        const commit = await v3.commitUpload(
          store,
          s.collection,
          { files: files.map(refOf) },
          { session, validate: false },
        )
        ms.push(performance.now() - t0)
        made.push({ number: commit.commit.number, file: files[0]!.id })
      }
    }),
  )
  report(store, { made, ms })
}

// --- Dispatch ---

const JOBS: Record<string, () => Promise<void>> = {
  'build-gen': buildGen,
  'build-dump': buildDump,
  verify,
  export: exportPart,
  many,
  race,
}

export async function runJob(job: string): Promise<void> {
  const fn = JOBS[job]
  if (!fn) throw new Error(`Unknown worker job "${job}"`)
  await fn()
}

export { schemas }
