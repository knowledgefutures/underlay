/**
 * Memory of every push job on large records: uploads, compactions, the commit's
 * planning, units and assembly, and indexing, run in this process on records
 * shaped like bibliographic metadata (several KB, non-ASCII text, long reference
 * lists). Prints, per job type, how many ran and the most live memory one held
 * above where it started: JS heap plus array buffers, after a forced GC, sampled
 * every few storage operations. Stored objects are on disk (a file store), and
 * the shared cache is off, as the Cache API sits outside a Worker's isolate; the
 * isolate's memory cache is the bulk Worker's 8 MB.
 *
 *   node --expose-gc --import tsx scripts/memory.ts [options]
 *
 *   --records N        records in the first push (default 90000, about 600 MB)
 *   --update N         records the second push changes, spread over the first's (default 20000)
 *   --commit-runs N    compactConfig.commitRuns (default 4, so the commit compacts first)
 *   --piece-mb N       compactConfig.pieceBytes in MB (default 128, so compactions split)
 *   --unit-mb N        parallelConfig.unitBytes and aboveBytes in MB (default: production's)
 *   --sample N         storage operations between samples (default 25; 0: none)
 *
 * Commit units over large leaves (Crossref works, 2026-10-16: leaves of 30 to 216
 * MB of records, records of 18 to 190 KB):
 *
 *   --record-kb N      records of about N KB: reference lists shaped like Crossref's,
 *                      which compress about as its works do (4.3x in 1 MB gzip members;
 *                      real works 4.1x). Over 64 KB a record is stored out of line.
 *   --leaf-mb A,B,...  the first push is leaves of about these MB of records, one type,
 *                      ids chosen so each leaf ends where its key hash says (needs --record-kb)
 *   --repush           later pushes send every record again, --update of them changed
 *                      (needs --record-kb; the others arrive identical, as in a re-commit)
 *   --pushes N         pushes in all (default 2); a third rewrites what the second wrote
 *   --above-mb N       parallelConfig.aboveBytes in MB (0: every commit goes parallel)
 *   --cache MODE       none (default), cold or warm: a shared cache outside the process,
 *                      like the Cache API, where a hit is a fresh copy. Before each later
 *                      push it is emptied; warm then holds every body, record and node of
 *                      the repository, as commit reads cached every body before #45 and
 *                      a version download (rawBody, bodyLines) still does.
 *   --timer-ms N       also sample every N ms
 *   --pieces           the bucket writes a body's members one after another, never joined,
 *                      as the R2 store does on Workers (Store.putPieces)
 *   --no-gc            unit samples never force a GC: times undisturbed, peaks only upper bounds
 *   --units            a report per commit unit (implied by --record-kb and --leaf-mb):
 *                      base leaves read and leaves written with their sizes and times, and
 *                      the unit's peak, where it was (which base leaf, how far in), and
 *                      what its sink held then
 *   --seed N           data seed (default 1)
 *   --read-ms N        then read the last version whole through records.ndjson and
 *                      records.ndjson.gz, as a client taking a chunk every N ms (find-doi
 *                      over a range, 2026-10-18), sampling at every chunk (default 0: no read)
 *
 * Unit peaks are sampled at every spill, leaf end and body write, on the timer, and
 * at storage operations; a sample forces a GC only when the reading without one
 * could be a new peak. A unit's memory is the JS heap plus array buffers (typed
 * arrays, and the copy a Blob makes of its bytes), as the jobs' report counts it.
 * Node's `external` is reported beside it, not added: it counts typed arrays again,
 * plus zlib's state (about 0.3 MB per stream compressing), which for a finished
 * stream stays there until a later GC finalizes it. workerd neither enforces nor
 * reports its 128 MB per isolate locally, so this is measured in Node: the same V8,
 * but its CompressionStream runs zlib on the libuv thread pool, where workerd's
 * runs on the isolate's thread. Here at most about four members compress at once;
 * in workerd (Miniflare, 2026-10-16) a member compresses only while the unit waits
 * on I/O, so a leaf read without waiting (its body a cache hit, or 4 MB or less
 * stored, and no out-of-line records) keeps every member compressing until the
 * leaf is written.
 *
 * Budgets not named here are the production ones (parallelConfig, runConfig).
 * A Worker has 128 MB per isolate, shared by the invocations it runs at once.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EventLoopUtilization, performance } from 'node:perf_hooks'

import {
  type BlobObject,
  boundaryBytes,
  type Cache,
  ed25519Signer,
  fileStore,
  generateSigningKey,
  LEAF_BOUNDARY_BITS,
  LEAF_MAX_ENTRIES,
  memoryStore,
  newSalt,
  noCache,
  type NodeDesc,
  type RecordEntry,
  Repo,
  RepoSink,
  sha256Hex,
  type PutOptions,
  type Store,
  trailingZeros,
} from '@underlay/protocol'
import { and, asc, eq, lte, sql } from 'drizzle-orm'

import '../src/handlers.js'
import { createApp } from '../src/app.js'
import { D1_MAX_BOUND_PARAMS, openNodeDb } from '../src/db/node.js'
import * as schema from '../src/db/schema.js'
import { BULK_JOBS, runJob, SqliteJobs } from '../src/jobs.js'
import type { JobMessage, Ports } from '../src/ports.js'
import { compactConfig } from '../src/push/compact.js'
import { MAX_BATCH_BYTES, MAX_BATCH_LINES } from '../src/push/delta.js'
import { parallelConfig } from '../src/push/parallel.js'
import { runConfig } from '../src/push/runs.js'
import { createStores } from '../src/stores.js'

const args = process.argv.slice(2)
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : def
}
const str = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? def) : def
}
const RECORDS = opt('records', 90_000)
const UPDATE = opt('update', 20_000)
const SAMPLE = opt('sample', 25)
const RECORD_KB = opt('record-kb', 0)
const LEAF_MB = str('leaf-mb', '').split(',').filter(Boolean).map(Number)
const REPUSH = args.includes('--repush')
const PUSHES = opt('pushes', 2)
const CACHE = str('cache', 'none')
const TIMER_MS = opt('timer-ms', 0)
const READ_MS = opt('read-ms', 0)
const PIECES = args.includes('--pieces')
const NO_GC = args.includes('--no-gc')
const UNITS = args.includes('--units') || RECORD_KB > 0 || LEAF_MB.length > 0
compactConfig.commitRuns = opt('commit-runs', 4)
compactConfig.pieceBytes = opt('piece-mb', 128) * 1024 * 1024
if (args.includes('--unit-mb'))
  parallelConfig.unitBytes = parallelConfig.aboveBytes = opt('unit-mb', 0) * 1024 * 1024
if (args.includes('--above-mb')) parallelConfig.aboveBytes = opt('above-mb', 0) * 1024 * 1024
if ((LEAF_MB.length > 0 || REPUSH) && RECORD_KB <= 0) {
  console.error('--leaf-mb and --repush need --record-kb')
  process.exit(2)
}
if (!['none', 'cold', 'warm'].includes(CACHE)) {
  console.error('--cache is none, cold or warm')
  process.exit(2)
}

const gc = (globalThis as { gc?: () => void }).gc
if (!gc) {
  console.error('Run with node --expose-gc --import tsx scripts/memory.ts')
  process.exit(2)
}
const collect: () => void = gc
// Jobs log their progress with console.log; stdout carries the report alone.
const report = (s: string) => process.stdout.write(`${s}\n`)
console.log = console.error
const MB = 1024 * 1024
let parts = { heap: 0, buffers: 0 }
const live = () => {
  gc()
  const m = process.memoryUsage()
  parts = { heap: m.heapUsed, buffers: m.arrayBuffers }
  return m.heapUsed + m.arrayBuffers
}

// --- Sampling ------------------------------------------------------------------------

let ops = 0
let peak = 0
let peakParts = { heap: 0, buffers: 0 }
const sample = () => {
  if (++ops % SAMPLE !== 0) return
  const m = live()
  if (m > peak) {
    peak = m
    peakParts = parts
  }
}
/** A store that samples memory every SAMPLE operations (and, in a unit, notes what it reads and writes). */
function sampled(store: Store): Store {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (prop === 'putPieces' && PIECES && target.putParts)
        return async (key: string, pieces: readonly Uint8Array[], opts?: PutOptions) => {
          sample()
          unitPut(key, pieces)
          await target.putParts!(
            key,
            (async function* () {
              yield* pieces
            })(),
            opts,
          )
          sample()
        }
      if (
        typeof v !== 'function' ||
        !['get', 'put', 'head', 'list', 'delete'].includes(String(prop))
      )
        return v
      return async (...a: unknown[]) => {
        sample()
        if (prop === 'put') unitPut(String(a[0]), a[1])
        const out = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a)
        sample()
        if (prop === 'get' && out) return unitGet(String(a[0]), out as BlobObject)
        return out
      }
    },
  })
}

const stats = new Map<
  string,
  { n: number; peak: number; heap: number; buffers: number; ms: number }
>()
async function measure(label: string, fn: () => Promise<unknown>) {
  const base = live()
  const baseParts = parts
  peak = base
  peakParts = parts
  const t = Date.now()
  await fn()
  sample()
  const s = stats.get(label) ?? { n: 0, peak: 0, heap: 0, buffers: 0, ms: 0 }
  s.n++
  if (peak - base > s.peak) {
    s.peak = peak - base
    s.heap = peakParts.heap - baseParts.heap
    s.buffers = peakParts.buffers - baseParts.buffers
  }
  s.ms += Date.now() - t
  stats.set(label, s)
}

// --- Commit units: what one holds, where, and for how long -----------------------------

/** A unit's live memory: JS heap plus array buffers (see the header). */
const total = (m: NodeJS.MemoryUsage) => m.heapUsed + m.arrayBuffers

/** Where a unit is: reading its `leaf`th base leaf (at `entry` of `entries`), between leaves, or flushing. */
interface Where {
  phase: 'start' | 'leaf' | 'between' | 'flush' | 'after'
  leaf: number
  entry: number
  entries: number
  /** Leaves the unit has finished (handed to its sink). */
  written: number
}
interface LeafRead {
  hash: string
  entries: number
  recordMB: number
  storedMB: number
  /** stream (over 4 MB stored), whole, cache (a hit: the whole body), lru */
  via: string
  start: number
  end: number
}
interface LeafWrite {
  hash: string
  entries: number
  recordMB: number
  /** The body's raw text (string length), and its stored size. */
  rawMB: number
  storedMB: number
  at: number
}
interface UnitRec {
  push: number
  id: string
  t0: number
  cpu: NodeJS.CpuUsage
  elu: EventLoopUtilization
  base: NodeJS.MemoryUsage
  peak: number
  peakMem: NodeJS.MemoryUsage | null
  peakAt: (Where & { trigger: string; s: number }) | null
  peakSink: Record<string, number> | null
  /** The largest reading without a GC (an upper bound, garbage included). */
  rawPeak: number
  maxCompressing: number
  maxMembers: number
  samples: number
  gcs: number
  reads: LeafRead[]
  writes: LeafWrite[]
  spills: number
  records: number
  cacheHits: number
}
let pushNo = 0
let cur: UnitRec | null = null
let at: Where = { phase: 'start', leaf: 0, entry: 0, entries: 0, written: 0 }
let sink: RepoSink<RecordEntry> | null = null
const since = (u: UnitRec) => (performance.now() - u.t0) / 1000
const sinkState = (s: RepoSink<RecordEntry>) => ({
  members: s.memberCount,
  memberMB: +(s.memberBytes / MB).toFixed(1),
  compressing: s.compressingCount,
  writes: s.writeCount,
  writeMB: +(s.writeBytes / MB).toFixed(1),
})

function unitSample(trigger: string) {
  const u = cur
  if (!u) return
  u.samples++
  if (sink) {
    u.maxCompressing = Math.max(u.maxCompressing, sink.compressingCount)
    u.maxMembers = Math.max(u.maxMembers, sink.memberCount)
  }
  let m = process.memoryUsage()
  const raw = total(m)
  if (raw > u.rawPeak) u.rawPeak = raw
  // Live memory is at most the reading without a GC: only a higher reading can be a new peak.
  if (raw <= u.peak) return
  if (!NO_GC) {
    collect()
    u.gcs++
    m = process.memoryUsage()
    if (m.heapUsed + m.arrayBuffers > peak) {
      peak = m.heapUsed + m.arrayBuffers
      peakParts = { heap: m.heapUsed, buffers: m.arrayBuffers }
    }
  }
  const t = total(m)
  if (t <= u.peak) return
  u.peak = t
  u.peakMem = m
  u.peakAt = { ...at, trigger, s: since(u) }
  u.peakSink = sink ? sinkState(sink) : null
}

const units: object[] = []
const reads = new Map<string, LeafRead>()

function beginUnit(id: string) {
  collect()
  const base = process.memoryUsage()
  at = { phase: 'start', leaf: 0, entry: 0, entries: 0, written: 0 }
  sink = null
  reads.clear()
  cur = {
    push: pushNo,
    id,
    t0: performance.now(),
    cpu: process.cpuUsage(),
    elu: performance.eventLoopUtilization(),
    base,
    peak: total(base),
    peakMem: null,
    peakAt: null,
    peakSink: null,
    rawPeak: total(base),
    maxCompressing: 0,
    maxMembers: 0,
    samples: 0,
    gcs: 0,
    reads: [],
    writes: [],
    spills: 0,
    records: 0,
    cacheHits: 0,
  }
}

async function endUnit() {
  const u = cur
  if (!u) return
  unitSample('end')
  cur = null
  const seconds = since(u)
  const cpu = process.cpuUsage(u.cpu)
  const elu = performance.eventLoopUtilization(u.elu)
  const [row] = await db
    .select({
      after: schema.commitUnits.after,
      through: schema.commitUnits.through,
      status: schema.commitUnits.status,
    })
    .from(schema.commitUnits)
    .where(eq(schema.commitUnits.id, u.id))
  const d = (n: number) => +(n / MB).toFixed(1)
  const m = u.peakMem ?? u.base
  const s1 = (n: number) => +n.toFixed(1)
  units.push({
    push: u.push,
    unit: u.id.slice(0, 8),
    range: [row?.after ?? null, row?.through ?? null],
    status: row?.status,
    seconds: s1(seconds),
    cpuSeconds: s1((cpu.user + cpu.system) / 1e6),
    mainThreadSeconds: s1(elu.active / 1000),
    peakMB: d(u.peak - total(u.base)),
    heapMB: d(m.heapUsed - u.base.heapUsed),
    arrayBuffersMB: d(m.arrayBuffers - u.base.arrayBuffers),
    externalMB: d(m.external - u.base.external),
    upperMB: d(u.rawPeak - total(u.base)),
    at: u.peakAt && {
      trigger: u.peakAt.trigger,
      phase: u.peakAt.phase,
      leaf: `${u.peakAt.leaf}/${u.reads.length}`,
      entry: `${u.peakAt.entry}/${u.peakAt.entries}`,
      written: u.peakAt.written,
      s: s1(u.peakAt.s),
    },
    sink: u.peakSink,
    maxCompressing: u.maxCompressing,
    maxMembers: u.maxMembers,
    read: u.reads.map((r) => ({
      entries: r.entries,
      recordMB: s1(r.recordMB),
      storedMB: s1(r.storedMB),
      via: r.via,
      seconds: s1(r.end - r.start),
    })),
    wrote: u.writes.map((w) => ({
      entries: w.entries,
      recordMB: s1(w.recordMB),
      rawMB: s1(w.rawMB),
      storedMB: s1(w.storedMB),
      at: s1(w.at),
    })),
    spills: u.spills,
    outOfLineReads: u.records,
    cacheHits: u.cacheHits,
    samples: u.samples,
    gcs: u.gcs,
  })
}

const isBody = (key: string) => key.startsWith('repo/bodies/')
const leafOfKey = (key: string) => key.slice('repo/bodies/'.length, -'.ndjson.gz'.length)

/** A body write: its stored size, sampled before the write starts (its members and their join are both live). */
function unitPut(key: string, body: unknown) {
  const u = cur
  if (!u || !isBody(key)) return
  const w = u.writes.find((x) => x.hash === leafOfKey(key))
  if (w && body instanceof Uint8Array) w.storedMB = body.byteLength / MB
  if (w && Array.isArray(body))
    w.storedMB = (body as Uint8Array[]).reduce((n, b) => n + b.byteLength, 0) / MB
  unitSample('body-put')
}

/** A body or out-of-line record read: how a base leaf's body was read. */
function unitGet(key: string, obj: BlobObject): BlobObject {
  const u = cur
  if (!u) return obj
  if (key.startsWith('repo/records/')) u.records++
  if (!isBody(key)) return obj
  const r = reads.get(leafOfKey(key))
  if (!r) return obj
  r.storedMB = obj.size / MB
  return new Proxy(obj, {
    get(t, p) {
      if (p === 'body') r.via = 'stream'
      if (p === 'bytes') r.via = 'whole'
      const v = Reflect.get(t, p, t) as unknown
      return typeof v === 'function' ? (v as () => unknown).bind(t) : v
    },
  })
}

if (UNITS) {
  type Sink = RepoSink<RecordEntry>
  /** The unit's sink: the one that spills and ends leaves while it runs. */
  const mine = (s: Sink) => {
    sink = s
  }
  const spill = RepoSink.prototype.spill
  RepoSink.prototype.spill = function (this: Sink, entries: readonly RecordEntry[]) {
    spill.call(this, entries)
    if (!cur) return
    mine(this)
    cur.spills++
    unitSample('spill')
  }
  const leaf = RepoSink.prototype.leaf
  RepoSink.prototype.leaf = function (
    this: Sink,
    desc: NodeDesc,
    json: string,
    entries: readonly RecordEntry[],
    spilled: number,
  ) {
    let raw = this.memberBytes
    for (let i = spilled; i < entries.length; i++) raw += (entries[i]!.body?.length ?? 0) + 1
    leaf.call(this, desc, json, entries, spilled)
    if (!cur) return
    mine(this)
    at.written++
    cur.writes.push({
      hash: desc.hash,
      entries: desc.count,
      recordMB: desc.bytes / MB,
      rawMB: raw / MB,
      storedMB: 0,
      at: since(cur),
    })
    unitSample('leaf-end')
  }
  const flush = RepoSink.prototype.flush
  RepoSink.prototype.flush = async function (this: Sink) {
    const unit = cur !== null && this === sink
    if (unit) at.phase = 'flush'
    await flush.call(this)
    if (unit) at.phase = 'after'
  }
  const bodyLines = Repo.prototype.bodyLineStream
  Repo.prototype.bodyLineStream = async function* (
    this: Repo,
    leaf: { hash: string; entries: readonly RecordEntry[] },
  ) {
    const u = cur
    if (!u) {
      yield* bodyLines.call(this, leaf)
      return
    }
    const r: LeafRead = {
      hash: leaf.hash,
      entries: leaf.entries.length,
      recordMB: leaf.entries.reduce((n, e) => n + e.size, 0) / MB,
      storedMB: 0,
      via: 'lru',
      start: since(u),
      end: 0,
    }
    u.reads.push(r)
    reads.set(leaf.hash, r)
    at = { ...at, phase: 'leaf', leaf: u.reads.length, entry: 0, entries: leaf.entries.length }
    try {
      for await (const line of bodyLines.call(this, leaf)) {
        at.entry++
        yield line
      }
    } finally {
      r.end = since(u)
      at.phase = 'between'
    }
  }
}
const timer = TIMER_MS > 0 ? setInterval(() => unitSample('timer'), TIMER_MS) : null
timer?.unref()

/**
 * A shared cache outside the process, like the Cache API: what it holds costs this
 * process nothing until it's read, and a hit is a fresh copy of the whole value.
 */
class DiskCache implements Cache {
  constructor(readonly dir: string) {}
  #file(key: string) {
    return join(this.dir, sha256Hex(key))
  }
  async get(key: string, opts?: { maxBytes?: number }): Promise<Uint8Array | null> {
    // Like CfCache: an entry over the cap is a miss, and isn't read.
    if (opts?.maxBytes !== undefined) {
      const size = (await stat(this.#file(key)).catch(() => null))?.size
      if (size === undefined || size > opts.maxBytes) return null
    }
    const b = await readFile(this.#file(key)).catch(() => null)
    if (!b) return null
    if (cur && key.includes('/bodies/')) {
      cur.cacheHits++
      const r = reads.get(key.slice(key.indexOf('/bodies/') + 8, -'.ndjson.gz'.length))
      if (r) {
        r.via = 'cache'
        r.storedMB = b.byteLength / MB
      }
    }
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  }
  async put(key: string, value: Uint8Array): Promise<void> {
    await writeFile(this.#file(key), value)
  }
  async clear() {
    await rm(this.dir, { recursive: true, force: true })
    await mkdir(this.dir, { recursive: true })
  }
}

// --- Records shaped like bibliographic metadata ---------------------------------------

// mulberry32: small, seedable, and good enough that ids don't collide.
const SEED = opt('seed', 1)
let seed = SEED
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!
const WORDS = [
  'analysis',
  'protein',
  'Étude',
  'über',
  'Gesellschaft',
  'climate',
  'résumé',
  'quantum',
  '研究',
  'データ',
  'модель',
  'ação',
  'network',
  'learning',
  'cell',
  'cancer',
  'São',
  'Zürich',
]
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
const token = () =>
  Math.floor(rand() * 36 ** 6).toString(36) + Math.floor(rand() * 36 ** 6).toString(36)

function work(doi: string, version = 0) {
  const authors = Array.from({ length: 2 + Math.floor(rand() * 18) }, () => ({
    given: words(1),
    family: words(1),
    sequence: 'additional',
    affiliation: [{ name: words(4) }],
  }))
  const refs = Array.from({ length: Math.floor(rand() * 50) }, (_, i) => ({
    key: `ref${i}`,
    DOI: `10.${1000 + Math.floor(rand() * 9000)}/${token()}`,
    'article-title': words(8),
    author: words(2),
    year: String(1950 + Math.floor(rand() * 75)),
    unstructured: words(20),
  }))
  return {
    id: doi,
    // The type follows the DOI, so an update lands on the same record.
    type: doi.charCodeAt(doi.length - 1) % 5 ? 'journal-article' : 'book-chapter',
    data: {
      DOI: doi,
      title: [words(10)],
      author: authors,
      reference: refs,
      abstract: rand() < 0.5 ? words(150) : undefined,
      published: { 'date-parts': [[2000 + Math.floor(rand() * 26), 1 + Math.floor(rand() * 12)]] },
      version,
    },
  }
}

// --- Records of a set size (--record-kb) --------------------------------------------------

/** mulberry32 from a given seed, for records generated from their id. */
const prng = (s: number) => () => {
  s = (s + 0x6d2b79f5) | 0
  let t = Math.imul(s ^ (s >>> 15), 1 | s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}
const hash32 = (s: string) => {
  let h = 2_166_136_261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16_777_619)
  return h | 0
}
// 3,000 made-up words: reference lists from them compress about as Crossref's do.
const SYLLABLES = ['ka', 'to', 'ri', 'mon', 'sel', 'vu', 'pha', 'en', 'dro', 'gli', 'stu', 'ber']
SYLLABLES.push('nax', 'ul', 'tie', 'ço', 'mü', 'ré', 'son', 'quil', 'za', 'ped', 'ox', 'lin')
const VOCAB = (() => {
  const r = prng(7)
  const syl = () => SYLLABLES[Math.floor(r() * SYLLABLES.length)]!
  return Array.from({ length: 3000 }, () =>
    Array.from({ length: 2 + Math.floor(r() * 3) }, syl).join(''),
  )
})()

/** A works record of about RECORD_KB, the same for the same id and version. */
function sizedWork(doi: string, version: number) {
  const r = prng(hash32(`${SEED}\u0000${doi}\u0000${version}`))
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a))
  const word = () => VOCAB[Math.floor(r() * VOCAB.length)]!
  const words = (n: number) => Array.from({ length: n }, word).join(' ')
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1)
  const ref = (i: number) => {
    const year = String(int(1950, 2025))
    const author = `${cap(word())} ${cap(word())[0]}.`
    const journal = cap(words(int(1, 4)))
    const title = words(int(6, 14))
    const volume = String(int(1, 300))
    const page = String(int(1, 2000))
    return {
      key: `e_1_2_${int(1, 9)}_${i}_1`,
      'doi-asserted-by': r() < 0.5 ? 'crossref' : 'publisher',
      DOI: `10.${int(1000, 9999)}/${Math.floor(r() * 36 ** 6).toString(36)}.${year}.${int(10, 999)}`,
      author,
      year,
      'journal-title': journal,
      volume,
      'first-page': page,
      'article-title': title,
      unstructured: `${author}, ${title}. ${journal} ${volume} (${year}) ${page}–${int(1, 2000)}.`,
    }
  }
  const data = {
    DOI: doi,
    title: [cap(words(int(6, 14)))],
    author: Array.from({ length: int(2, 12) }, () => ({ given: cap(word()), family: cap(word()) })),
    published: { 'date-parts': [[int(1990, 2026), int(1, 13)]] },
    version,
    reference: [] as object[],
  }
  const rec = { id: doi, type: 'journal-article', data }
  const target = RECORD_KB * 1024
  let size = Buffer.byteLength(JSON.stringify(rec))
  for (let i = 0; size < target; i++) {
    const x = ref(i)
    data.reference.push(x)
    size += Buffer.byteLength(JSON.stringify(x)) + 1
  }
  return rec
}

/**
 * Ids for leaves of about LEAF_MB each: every id but a leaf's last has a key hash
 * that is no leaf boundary, and the last has one, so the leaf ends exactly there.
 */
function leafIds(): string[] {
  const natural = (k: string) => trailingZeros(boundaryBytes(k)) >= LEAF_BOUNDARY_BITS
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  const ids: string[] = []
  for (const [l, mb] of LEAF_MB.entries()) {
    const n = Math.max(1, Math.round((mb * 1024) / RECORD_KB))
    if (n > LEAF_MAX_ENTRIES) throw new Error(`A leaf of ${mb} MB needs ${n} records`)
    for (let i = 0; i < n; i++) {
      let id = `10.5555/l${pad(l, 4)}.${pad(i, 5)}`
      if (i < n - 1) while (natural(id)) id += 'x'
      else {
        let j = 0
        while (!natural(`${id}-${j}`)) j++
        id = `${id}-${j}`
      }
      ids.push(id)
    }
  }
  return ids
}

// --- Ports -----------------------------------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), 'ul-memory-'))
const db = await openNodeDb(`file:${join(dir, 'db.sqlite')}`, {
  maxBoundParams: D1_MAX_BOUND_PARAMS,
})
const bucket = sampled(fileStore(join(dir, 'bucket')))
const diskCache = CACHE === 'none' ? null : new DiskCache(join(dir, 'cache'))
await diskCache?.clear()
const cache: Cache = diskCache ?? noCache
const signer = await ed25519Signer(await generateSigningKey())
const ports: Ports = {
  db,
  stores: createStores(db, cache, {
    bucket,
    // File bytes aren't part of this; the store only has to presign.
    files: memoryStore() as never,
    repoPrefix: 'repo',
    internalPrefix: 'internal',
    memoryBytes: 8 * MB,
  }),
  cache,
  signer: async () => signer,
  jobs: new SqliteJobs(db),
  waitUntil: (p) => void p.catch((err) => console.error(err)),
  outboundFetch: (url, init) => fetch(url, init),
  locationFetch: (req) => fetch(req),
  locationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
}
const app = createApp(() => ({
  ports,
  config: { appUrl: 'http://memory', deployment: 'test' },
  authenticate: async () => ({ userId: 'u1', scope: 'session', collectionIds: null }),
}))
await db.insert(schema.organization).values({ id: 'org1', name: 'Org', slug: 'org' })
await db.insert(schema.user).values({ id: 'u1', name: 'u1', email: 'u1@example.org' })
await db.insert(schema.member).values({ organizationId: 'org1', userId: 'u1', role: 'owner' })
const [collection] = await db
  .insert(schema.collections)
  .values({ organizationId: 'org1', slug: 'works', name: 'works', privateSalt: newSalt() })
  .returning()
await db.insert(schema.placements).values({
  collectionId: collection!.id,
  locationId: schema.PLATFORM_LOCATION_ID,
  role: 'primary',
  sets: 'public+private',
})
const path = '/api/collections/org/works'
const request = (p: string, init: { method?: string; body?: string; json?: unknown } = {}) =>
  app.fetch(
    new Request(`http://memory${p}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': init.json !== undefined ? 'application/json' : 'application/x-ndjson',
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
  )

/** Run queued jobs one at a time, interactive first (as claim orders them), measuring each. */
async function drain() {
  for (;;) {
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, 'queued'), lte(schema.jobs.runAt, new Date())))
      .orderBy(
        sql`CASE WHEN ${schema.jobs.type} IN (${sql.join(
          [...BULK_JOBS].map((t) => sql`${t}`),
          sql`, `,
        )}) THEN 1 ELSE 0 END`,
        asc(schema.jobs.runAt),
      )
      .limit(1)
    if (!job) return
    await db.delete(schema.jobs).where(eq(schema.jobs.id, job.id))
    const message = job.payload as JobMessage
    if (UNITS && message.type === 'commit.unit') {
      await measure(job.type, async () => {
        beginUnit(String(message.unitId))
        try {
          await runJob(message, ports)
        } finally {
          await endUnit()
        }
      })
    } else await measure(job.type, () => runJob(message, ports))
  }
}

/** One push: open, upload batches up to the server's limits, commit, run every job. */
async function push(records: Iterable<object>, schemas: Record<string, unknown> | undefined) {
  const open = await request(`${path}/push`, { method: 'POST', json: schemas ? { schemas } : {} })
  const sid = ((await open.json()) as { session_id: string }).session_id
  let lines: string[] = []
  let bytes = 0
  const send = async () => {
    const body = lines.join('\n')
    lines = []
    bytes = 0
    await measure('upload (request)', async () => {
      const r = await request(`${path}/push/${sid}/records`, { method: 'POST', body })
      if (r.status !== 200) throw new Error(`upload: ${r.status} ${await r.text()}`)
    })
    // Uploads queue compactions; run them as they come, as the queue would.
    await drain()
  }
  for (const rec of records) {
    const line = JSON.stringify(rec)
    const n = Buffer.byteLength(line) + 1
    if (lines.length >= MAX_BATCH_LINES || bytes + n > MAX_BATCH_BYTES - 64 * 1024) await send()
    lines.push(line)
    bytes += n
  }
  if (lines.length) await send()
  const t = Date.now()
  const c = await request(`${path}/push/${sid}/commit`, { method: 'POST', json: { async: true } })
  if (c.status !== 202) throw new Error(`commit: ${c.status} ${await c.text()}`)
  await drain()
  const s = (await (await request(`${path}/push/${sid}`)).json()) as {
    status: string
    error: unknown
    result: { semver: string; recordCount: number; changes: unknown }
  }
  if (s.status !== 'committed')
    throw new Error(`commit ended ${s.status}: ${JSON.stringify(s.error)}`)
  const { semver, recordCount, changes } = s.result
  console.error(`  ${semver}: ${recordCount} records, changes ${JSON.stringify(changes)}`)
  return Date.now() - t
}

/** Before a later push: empty the shared cache, and when warm, fill it with every stored body, record and node. */
async function prepareCache() {
  if (!diskCache) return
  await diskCache.clear()
  if (CACHE !== 'warm') return
  let n = 0
  let bytes = 0
  for (const kind of ['bodies', 'records', 'nodes']) {
    const from = join(dir, 'bucket', 'repo', kind)
    for (const name of await readdir(from).catch(() => [] as string[])) {
      if (name.endsWith('.__type') || name.endsWith('.tmp')) continue
      const b = await readFile(join(from, name))
      await diskCache.put(`loc:${schema.PLATFORM_LOCATION_ID}/${kind}/${name}`, b)
      n++
      bytes += b.byteLength
    }
  }
  console.error(`  cache warmed: ${n} objects, ${(bytes / MB).toFixed(0)} MB`)
}

const schemas = { 'journal-article': { type: 'object' }, 'book-chapter': { type: 'object' } }
const dois =
  LEAF_MB.length > 0
    ? leafIds()
    : Array.from({ length: RECORDS }, () => `10.${1000 + Math.floor(rand() * 9000)}/${token()}`)
const record = (doi: string, version: number) =>
  RECORD_KB > 0 ? sizedWork(doi, version) : work(doi, version)
/** Each record's version as last pushed (--repush sends it again unchanged). */
const versions = new Uint16Array(dois.length)
let rawBytes = 0
const first = function* () {
  for (const d of dois) {
    const w = record(d, 0)
    rawBytes += Buffer.byteLength(JSON.stringify(w))
    yield w
  }
}
const pushes: object[] = []
pushNo = 1
console.error(`push 1: ${dois.length} records`)
const c1 = await push(first(), schemas)
console.error(
  `push 1 committed (${(rawBytes / MB).toFixed(0)} MB of records, commit ${(c1 / 1000).toFixed(0)} s)`,
)
pushes.push({ push: 1, records: dois.length, commitSeconds: Math.round(c1 / 1000) })
for (pushNo = 2; pushNo <= PUSHES; pushNo++) {
  const version = pushNo - 1
  const later = function* () {
    if (!REPUSH) {
      for (let i = 0; i < UPDATE; i++) {
        const k = Math.floor(rand() * dois.length)
        versions[k] = version
        yield record(dois[k]!, version)
      }
      return
    }
    const order = dois.map((_, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    // The first UPDATE of the shuffled records change; the rest arrive as they are.
    for (const [n, k] of order.entries()) {
      if (n < UPDATE) versions[k] = version
      yield record(dois[k]!, versions[k]!)
    }
  }
  await prepareCache()
  const before = units.length
  console.error(
    REPUSH
      ? `push ${pushNo}: every record again, ${UPDATE} changed`
      : `push ${pushNo}: ${UPDATE} updates spread over the first push's records`,
  )
  const c = await push(later(), undefined)
  console.error(`push ${pushNo} committed (commit ${(c / 1000).toFixed(0)} s)`)
  pushes.push({ push: pushNo, commitSeconds: Math.round(c / 1000), units: units.length - before })
}
// The version read whole by a client slower than the server: what a read holds
// is what it has fetched and not yet sent.
if (READ_MS > 0) {
  for (const route of ['records.ndjson', 'records.ndjson.gz']) {
    await measure(`${route} (read)`, async () => {
      const res = await request(`${path}/versions/latest/${route}`)
      if (res.status !== 200) throw new Error(`${route}: ${res.status} ${await res.text()}`)
      const reader = res.body!.getReader()
      for (;;) {
        const { done } = await reader.read()
        ops = SAMPLE - 1 // sample at every chunk
        sample()
        if (done) return
        await new Promise((r) => setTimeout(r, READ_MS))
      }
    })
  }
}
if (timer) clearInterval(timer)

const rows = [...stats].sort((a, b) => b[1].peak - a[1].peak)
report(
  JSON.stringify(
    {
      records: dois.length,
      recordMB: Math.round(rawBytes / MB),
      updates: UPDATE,
      budgets: {
        unitMB: parallelConfig.unitBytes / MB,
        aboveMB: parallelConfig.aboveBytes / MB,
        pieceMB: compactConfig.pieceBytes / MB,
        commitRuns: compactConfig.commitRuns,
        prefetchMB: runConfig.prefetchBudget / MB,
      },
      jobs: Object.fromEntries(
        rows.map(([k, v]) => [
          k,
          {
            n: v.n,
            peakMB: +(v.peak / MB).toFixed(1),
            heapMB: +(v.heap / MB).toFixed(1),
            buffersMB: +(v.buffers / MB).toFixed(1),
            seconds: Math.round(v.ms / 1000),
          },
        ]),
      ),
      ...(UNITS
        ? {
            shape: {
              recordKB: RECORD_KB || null,
              leafMB: LEAF_MB.length > 0 ? LEAF_MB : null,
              repush: REPUSH,
              cache: CACHE,
              timerMs: TIMER_MS || null,
              noGc: NO_GC,
              seed: SEED,
            },
            pushes,
            units,
          }
        : {}),
    },
    null,
    2,
  ),
)
await rm(dir, { recursive: true, force: true })
