/**
 * Sorted runs: how push sessions hold uploaded data until commit (the external
 * sort of edge-redesign-build.md finding 11).
 *
 * Each upload batch becomes one run, sorted by (type, id). A run is a sequence
 * of blocks of about 64 KB of NDJSON, each gzipped on its own and concatenated
 * into part objects of a few MB, in the platform's internal area:
 *
 *   sessions/<sessionId>/runs/<seq>/<part>.ndjson.gz
 *   sessions/<sessionId>/runs/<seq>/<part>.blocks.json   the part's blocks
 *   sessions/<sessionId>/runs/<seq>/index.json           {v: 2, seq, tier, parts: [...]}
 *
 * A compacted run's parts are stored uncompressed (`<part>.ndjson`, `raw` in
 * the index). Gzip was three quarters of a merge's CPU, and a session's
 * compactions share one isolate's thread: a 30M-record Crossref session spent
 * 12 hours compacting (staging, 2026-10-18). A run is read a few times and
 * deleted with its session, so the bytes saved weren't worth it. Upload runs
 * stay gzipped.
 *
 * The index is a summary: per part, its first and last key, entry count, raw
 * and compressed size, and its natural-boundary marks (below). Each part's
 * blocks (first and last key, entry count, byte range in the part) are a page
 * of their own, read only by a cursor that reaches the part. So a planner reads
 * O(parts) for any size of push, and a reader fetches only the blocks
 * overlapping its key range, by range GET. Indexes written before pages
 * (`{seq, tier, blocks}`) still read: their blocks become inline pages.
 *
 * Precedence: an entry's precedence is the seq of the upload it came from
 * (`q`, or the run's seq for an upload run). On equal keys the highest
 * precedence wins: later uploads replace earlier ones. Because precedence is
 * carried per entry, any group of runs can be compacted into one, and a
 * compaction can be split by key range into pieces that run as separate jobs
 * (compact.ts): the pieces' parts, in key order, are the merged run.
 *
 * Memory: a reader holds one part's block page, one block's lines and a
 * bounded prefetch of stored bytes, so a k-way merge stays within a Worker
 * for any run size. The number of runs a merge reads is bounded by compaction.
 */
import {
  boundaryBytes,
  compareUtf8,
  gunzipText,
  gzip,
  splitLines,
  trailingZeros,
} from '@underlay/protocol'

import type { Store } from '../ports.js'

/**
 * One entry of a run. `k` is the record id, `t` the type. Its line's field
 * order is load-bearing: compaction reads `t` and `k` from the start, `x` right
 * after `k`, and `q` from the end without parsing (readRunLine), so lines are
 * written with runLine.
 */
export interface RunEntry {
  t: string
  k: string
  /** Record hash (records runs). */
  h?: string
  /** Canonical record size in bytes. */
  s?: number
  /** Pushed as private. */
  p?: boolean
  /** The canonical record (records runs). */
  b?: string
  /** A delete (delta deletes runs). */
  x?: boolean
  /** Precedence: the seq of the upload this entry came from (compacted runs only). */
  q?: number
}

export interface RunBlock {
  /** First and last run keys (`type\u0000id`). */
  first: string
  last: string
  count: number
  /** Part object number, and the block's byte range in it. */
  part: number
  offset: number
  length: number
  /** Split-key candidates (indexes written before pages kept them per block). */
  marks?: string[]
  p?: true
}

export interface RunPart {
  /** Part object number: a name, not a position (a compaction piece numbers its own). */
  part: number
  /** First and last run keys. */
  first: string
  last: string
  count: number
  /** Raw NDJSON size, about (string length), for byte budgets. */
  bytes: number
  /** Size of the part object (compressed, unless `raw`). */
  length: number
  /** Stored uncompressed, as `<part>.ndjson` (a compacted run). */
  raw?: true
  /**
   * Natural-boundary marks: run keys of the part's upserts whose id has at
   * least MARK_BITS trailing zeros in its boundary hash. They're the split-key
   * candidates for parallel commit units, about one per 8k entries, so the
   * planner reads no data.
   */
  marks?: string[]
  /** Some upsert in the part was pushed as private. */
  p?: true
  /** The part's blocks, inline: indexes written before pages. Otherwise `<part>.blocks.json`. */
  blocks?: RunBlock[]
}

export interface RunIndex {
  seq: number
  /** 0 for an upload, n for a run compacted from runs of tier ≤ n − 1. */
  tier?: number
  /** In key order; disjoint. A planner's slice of a run lists only the parts it needs. */
  parts: RunPart[]
}

/** A slice of one type: ids in `(after, through]`; null is unbounded. */
export interface RunRange {
  type: string
  after?: string | null
  through?: string | null
}

/** A range of run keys `(after, through]` across types (a compaction piece); null is unbounded. */
export interface KeyRange {
  after: string | null
  through: string | null
}

export const BLOCK_BYTES = 64 * 1024
/** Runs per compaction. */
export const MERGE_FAN_IN = 16
/** 2^13 = 8,192: about one mark per eight leaves. */
export const MARK_BITS = 13

export const runConfig = {
  /** Stored bytes per part object. A writer holds one open part and one being stored. */
  partBytes: 4 * 1024 * 1024,
  /**
   * Stored bytes a merge holds, split across its runs. Each cursor holds its
   * current span and the next one, so a span gets half of a run's share. With
   * records of several KB, 8 MB a span left a two-run commit unit holding 16 MB
   * of spans alone (2026-10-15).
   */
  prefetchBudget: 4 * 1024 * 1024,
}

/**
 * A run line with only what a compaction needs read from it: it moves lines
 * without parsing them. `JSON.parse` and `JSON.stringify` of every entry were
 * half of a merge's CPU once runs were stored uncompressed (2026-10-18).
 */
export interface RunLine {
  t: string
  k: string
  q?: number
  x?: true
  p?: true
  line: string
  /** The precedence written in the line, if any. */
  lineQ?: number
}

const LINE_START = '{"t":"'
const LINE_ID = '","k":"'
const LINE_DELETE = ',"x":true'
const LINE_PRIVATE = ',"p":true'
const LINE_Q = ',"q":'
/** `,"q":` and up to 16 digits and `}`: the precedence ends a line. */
const LINE_Q_TAIL = 24

/** An entry as a run line, its fields in the order readRunLine reads: type, id, delete, the rest, precedence. */
export function runLine(e: RunEntry): string {
  const { t, k, x, q, ...rest } = e
  return JSON.stringify({ t, k, ...(x ? { x } : {}), ...rest, ...(q === undefined ? {} : { q }) })
}

/**
 * A run line, read without parsing it. RunWriter writes every entry as
 * `{"t":…,"k":…` then `"x":true` for a delete, the other fields, and `"q":n`
 * last, so the type and id are read from the start and the precedence from the
 * end. A type or id with an escape, or any other shape, is parsed in full.
 *
 * A field can't be mistaken for text inside a string: every quote in a JSON
 * string is escaped, so `,"p":` only ever starts a field. Only a part marked
 * private (`maybePrivate`) is searched for it.
 */
export function readRunLine(line: string, maybePrivate = true): RunLine {
  if (line.startsWith(LINE_START) && line.endsWith('}')) {
    const te = line.indexOf('"', LINE_START.length)
    const ke = te < 0 || !line.startsWith(LINE_ID, te) ? -1 : line.indexOf('"', te + LINE_ID.length)
    const t = line.slice(LINE_START.length, te)
    const k = line.slice(te + LINE_ID.length, ke)
    if (ke > 0 && !t.includes('\\') && !k.includes('\\')) {
      const e: RunLine = { t, k, line }
      if (line.startsWith(LINE_DELETE, ke + 1)) e.x = true
      else if (maybePrivate && line.includes(LINE_PRIVATE)) e.p = true
      const qi = line.indexOf(LINE_Q, Math.max(0, line.length - LINE_Q_TAIL))
      if (qi < 0) return e
      const q = line.slice(qi + LINE_Q.length, -1)
      if (/^\d+$/.test(q)) {
        e.q = e.lineQ = Number(q)
        return e
      }
    }
  }
  const { t, k, q, x, p } = JSON.parse(line) as RunEntry
  return {
    t,
    k,
    line,
    ...(q === undefined ? {} : { q, lineQ: q }),
    ...(x ? { x: true as const } : {}),
    ...(p ? { p: true as const } : {}),
  }
}

/** Sort key: type, then id, by UTF-8 bytes. A NUL separator keeps types apart. */
export const runKey = (e: { t: string; k: string }) => `${e.t}\u0000${e.k}`
export const compareRunKeys = (a: { t: string; k: string }, b: { t: string; k: string }) =>
  compareUtf8(a.t, b.t) || compareUtf8(a.k, b.k)

const runPrefix = (sessionId: string, seq: number) => `sessions/${sessionId}/runs/${seq}`
const partKey = (sessionId: string, seq: number, part: number, raw?: boolean) =>
  `${runPrefix(sessionId, seq)}/${part}.ndjson${raw ? '' : '.gz'}`
const pageKey = (sessionId: string, seq: number, part: number) =>
  `${runPrefix(sessionId, seq)}/${part}.blocks.json`
export const indexKey = (sessionId: string, seq: number) =>
  `${runPrefix(sessionId, seq)}/index.json`

/** Is this id a split-key candidate? */
export const isMark = (id: string) => trailingZeros(boundaryBytes(id)) >= MARK_BITS

/** Entries in a run, and its raw size. */
export const runCount = (ix: RunIndex) => ix.parts.reduce((n, p) => n + p.count, 0)
export const runBytes = (ix: RunIndex) => ix.parts.reduce((n, p) => n + p.bytes, 0)

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Writes one run block by block. Entries must arrive sorted. */
export class RunWriter {
  readonly #parts: RunPart[] = []
  #lines: string[] = []
  #marks: string[] = []
  #private = false
  #first: string | null = null
  #last: string | null = null
  #bytes = 0
  // Blocks are compressed in order on one chain, then appended to the open part.
  #chain: Promise<void> = Promise.resolve()
  #queued = 0
  #part: number
  #partChunks: Uint8Array[] = []
  #partBytes = 0
  #partBlocks: RunBlock[] = []
  #partMarks: string[] = []
  #partPrivate = false
  #partRaw = 0
  readonly #puts: Promise<void>[] = []

  /**
   * `partBase` numbers this writer's parts (a compaction piece writes into a
   * run other pieces write too); `writeIndex: false` leaves the index to whoever
   * joins the pieces; `raw` stores the parts uncompressed.
   */
  constructor(
    readonly store: Store,
    readonly sessionId: string,
    readonly seq: number,
    readonly tier = 0,
    readonly opts: { partBase?: number; writeIndex?: boolean; raw?: boolean } = {},
  ) {
    this.#part = opts.partBase ?? 0
  }

  add(e: RunEntry): void {
    this.#add(e.k, runKey(e), runLine(e), e.x === true, e.p === true)
  }

  /** A line read by readRunLine, with the precedence it now has written in. */
  addLine(e: RunLine): void {
    let line = e.line
    if (e.q !== e.lineQ) {
      line =
        e.lineQ === undefined
          ? `${line.slice(0, -1)}${LINE_Q}${e.q}}`
          : JSON.stringify({ ...(JSON.parse(line) as RunEntry), q: e.q })
    }
    this.#add(e.k, runKey(e), line, e.x === true, e.p === true)
  }

  #add(id: string, key: string, line: string, del: boolean, priv: boolean) {
    if (this.#last !== null && compareUtf8(this.#last, key) >= 0) {
      throw new Error(`Run entries out of order at ${JSON.stringify(key)}`)
    }
    this.#first ??= key
    this.#last = key
    this.#lines.push(line)
    if (!del && isMark(id)) this.#marks.push(key)
    if (priv) this.#private = true
    this.#bytes += line.length + 1
    if (this.#bytes >= BLOCK_BYTES) this.#flushBlock()
  }

  #flushBlock() {
    if (this.#lines.length === 0) return
    const text = this.#lines.join('\n') + '\n'
    const block = { first: this.#first!, last: this.#last!, count: this.#lines.length }
    const marks = this.#marks
    const priv = this.#private
    const raw = this.#bytes
    this.#lines = []
    this.#marks = []
    this.#private = false
    this.#bytes = 0
    this.#first = null
    this.#queued++
    this.#chain = this.#chain.then(async () => {
      const stored = this.opts.raw ? enc.encode(text) : await gzip(text)
      this.#partBlocks.push({
        ...block,
        part: this.#part,
        offset: this.#partBytes,
        length: stored.length,
      })
      this.#partMarks.push(...marks)
      if (priv) this.#partPrivate = true
      this.#partRaw += raw
      this.#partChunks.push(stored)
      this.#partBytes += stored.length
      this.#queued--
      if (this.#partBytes >= runConfig.partBytes) this.#flushPart()
    })
  }

  #flushPart() {
    if (this.#partBytes === 0) return
    const body = new Uint8Array(this.#partBytes)
    let at = 0
    for (const c of this.#partChunks) {
      body.set(c, at)
      at += c.length
    }
    const blocks = this.#partBlocks
    const part = this.#part
    this.#parts.push({
      part,
      first: blocks[0]!.first,
      last: blocks[blocks.length - 1]!.last,
      count: blocks.reduce((n, b) => n + b.count, 0),
      bytes: this.#partRaw,
      length: this.#partBytes,
      ...(this.#partMarks.length > 0 ? { marks: this.#partMarks } : {}),
      ...(this.#partPrivate ? { p: true as const } : {}),
      ...(this.opts.raw ? { raw: true as const } : {}),
    })
    const store = this.store
    this.#puts.push(
      Promise.all([
        store.put(partKey(this.sessionId, this.seq, part, this.opts.raw), body, {
          contentType: this.opts.raw ? 'application/x-ndjson' : 'application/gzip',
        }),
        store.put(pageKey(this.sessionId, this.seq, part), JSON.stringify(blocks), {
          contentType: 'application/json',
        }),
      ]).then(() => {}),
    )
    this.#part++
    this.#partChunks = []
    this.#partBytes = 0
    this.#partBlocks = []
    this.#partMarks = []
    this.#partPrivate = false
    this.#partRaw = 0
  }

  /** Bounded memory: callers writing large runs await this between entries. */
  async drain(): Promise<void> {
    if (this.#queued >= 4) await this.#chain
    // One part being stored while the next fills: when a second part is
    // flushed, wait for the first's put. Two parts in memory at most.
    if (this.#puts.length >= 2) await this.#puts.shift()
  }

  async finish(): Promise<RunIndex> {
    this.#flushBlock()
    await this.#chain
    this.#flushPart()
    await Promise.all(this.#puts.splice(0))
    const index: RunIndex = { seq: this.seq, tier: this.tier, parts: this.#parts }
    if (this.opts.writeIndex !== false) await writeRunIndex(this.store, this.sessionId, index)
    return index
  }
}

export async function writeRunIndex(
  store: Store,
  sessionId: string,
  index: RunIndex,
  /** Keep an index already there (it's the same: a compaction's pieces joined twice). */
  opts: { ifAbsent?: boolean } = {},
) {
  await store.put(indexKey(sessionId, index.seq), JSON.stringify({ v: 2, ...index }), {
    contentType: 'application/json',
    ...(opts.ifAbsent ? { ifAbsent: true } : {}),
  })
}

/** Write an in-memory batch (one upload request) as a run. */
export async function writeRun(store: Store, sessionId: string, seq: number, entries: RunEntry[]) {
  entries.sort(compareRunKeys)
  // Within one batch the last occurrence of a key wins.
  const w = new RunWriter(store, sessionId, seq)
  for (let i = 0; i < entries.length; i++) {
    const next = entries[i + 1]
    if (next && compareRunKeys(entries[i]!, next) === 0) continue
    w.add(entries[i]!)
  }
  return w.finish()
}

/**
 * A run index (or a slice of one) as stored, in the current form. An index from
 * before pages lists blocks: each part becomes a part with its blocks inline,
 * its raw size estimated from the compressed one.
 */
export function normalizeIndex(raw: {
  seq: number
  tier?: number
  parts?: RunPart[]
  blocks?: RunBlock[]
}): RunIndex {
  if (raw.parts) return { seq: raw.seq, tier: raw.tier ?? 0, parts: raw.parts }
  const parts: RunPart[] = []
  for (const b of raw.blocks ?? []) {
    let p = parts[parts.length - 1]
    if (!p || p.part !== b.part) {
      p = { part: b.part, first: b.first, last: b.last, count: 0, bytes: 0, length: 0, blocks: [] }
      parts.push(p)
    }
    p.last = b.last
    p.count += b.count
    p.length += b.length
    p.bytes += b.length * 4
    p.blocks!.push(b)
    if (b.marks) p.marks = [...(p.marks ?? []), ...b.marks]
    if (b.p) p.p = true
  }
  return { seq: raw.seq, tier: raw.tier ?? 0, parts }
}

export async function readRunIndex(
  store: Store,
  sessionId: string,
  seq: number,
): Promise<RunIndex> {
  const obj = await store.get(indexKey(sessionId, seq))
  if (!obj) throw new Error(`Run ${seq} of session ${sessionId} is missing`)
  return normalizeIndex(JSON.parse(await obj.text()))
}

// --- Ranges -------------------------------------------------------------------------

/** Run-key bounds: keys k with lo < k, and k ≤ hi (k < hi when `hiOpen`). Null is unbounded. */
interface Bounds {
  lo: string | null
  hi: string | null
  hiOpen: boolean
}

function boundsOf(range: RunRange | KeyRange | string): Bounds {
  if (typeof range === 'string') range = { type: range }
  if (!('type' in range)) return { lo: range.after, hi: range.through, hiOpen: false }
  // Every key of the type sorts after `type\0` and before `type\u0001`.
  return {
    lo: `${range.type}\u0000${range.after ?? ''}`,
    hi: range.through == null ? `${range.type}\u0001` : `${range.type}\u0000${range.through}`,
    hiOpen: range.through == null,
  }
}

const inBounds = (b: Bounds, key: string) =>
  (b.lo === null || compareUtf8(key, b.lo) > 0) &&
  (b.hi === null || (b.hiOpen ? compareUtf8(key, b.hi) < 0 : compareUtf8(key, b.hi) <= 0))

/** Is the entry inside the range? */
export function inRunRange(range: RunRange | KeyRange, e: { t: string; k: string }): boolean {
  return inBounds(boundsOf(range), runKey(e))
}

/**
 * The items (parts, or a part's blocks) that can hold keys in the bounds: a
 * contiguous span, found by binary search (items are sorted and disjoint).
 */
function overlapping<T extends { first: string; last: string }>(items: T[], b: Bounds): T[] {
  const search = (pred: (x: T) => boolean) => {
    let a = 0
    let z = items.length
    while (a < z) {
      const m = (a + z) >> 1
      if (pred(items[m]!)) z = m
      else a = m + 1
    }
    return a
  }
  const start = b.lo === null ? 0 : search((x) => compareUtf8(x.last, b.lo!) > 0)
  const end =
    b.hi === null
      ? items.length
      : search((x) =>
          b.hiOpen ? compareUtf8(x.first, b.hi!) >= 0 : compareUtf8(x.first, b.hi!) > 0,
        )
  return items.slice(start, Math.max(start, end))
}

/** The parts of a run that can hold entries in the range. */
export function partsInRange(index: RunIndex, range?: RunRange | KeyRange | string): RunPart[] {
  return range === undefined ? index.parts : overlapping(index.parts, boundsOf(range))
}

/** A run cut down to the parts a range needs (a commit unit's or a compaction piece's slice). */
export const sliceRun = (index: RunIndex, range: RunRange | KeyRange): RunIndex => ({
  seq: index.seq,
  tier: index.tier ?? 0,
  parts: partsInRange(index, range),
})

// --- Reading ---------------------------------------------------------------------------

/**
 * Reads one run's entries in order, optionally limited to a range. Part by
 * part: the part's block page is read, then neighbouring blocks are fetched
 * together, up to `spanBytes` compressed, the next span prefetched while the
 * current one is consumed. Only the current block is decompressed, and lines
 * are parsed one at a time.
 */
export class RunCursor<E extends { t: string; k: string; q?: number } = RunEntry> {
  readonly #parts: RunPart[]
  #part = 0
  #page: Promise<RunBlock[]> | null = null
  #spans: RunBlock[][] = []
  #span = 0
  #fetch: Promise<Uint8Array[]> | null = null
  #blocks: Uint8Array[] = []
  /** The current part is stored uncompressed. */
  #raw = false
  /** The current part holds a private upsert. */
  #private = false
  #lines: string[] = []
  #line = 0
  readonly #bounds: Bounds | undefined
  /** The current entry, or undefined once the run is exhausted. */
  head: E | undefined

  constructor(
    readonly store: Store,
    readonly sessionId: string,
    readonly index: RunIndex,
    range?: RunRange | KeyRange | string,
    readonly spanBytes = 1024 * 1024,
    /** Reads a line; `maybePrivate` is its part's `p`. */
    readonly parse: (line: string, maybePrivate: boolean) => E = (line) => JSON.parse(line) as E,
  ) {
    this.#bounds = range === undefined ? undefined : boundsOf(range)
    this.#parts = this.#bounds ? overlapping(index.parts, this.#bounds) : index.parts
  }

  #loadPage(i: number): Promise<RunBlock[]> {
    const part = this.#parts[i]!
    if (part.blocks) return Promise.resolve(part.blocks)
    const key = pageKey(this.sessionId, this.index.seq, part.part)
    const p = this.store.get(key).then(async (obj) => {
      if (!obj) throw new Error(`Run page ${key} is missing`)
      return JSON.parse(await obj.text()) as RunBlock[]
    })
    p.catch(() => {})
    return p
  }

  /** Spans of the part's blocks in range. */
  #plan(blocks: RunBlock[]) {
    const spans: RunBlock[][] = []
    let cur: RunBlock[] = []
    let bytes = 0
    for (const b of this.#bounds ? overlapping(blocks, this.#bounds) : blocks) {
      const prev = cur[cur.length - 1]
      const contiguous = prev && prev.offset + prev.length === b.offset
      if (prev && (!contiguous || bytes + b.length > this.spanBytes)) {
        spans.push(cur)
        cur = []
        bytes = 0
      }
      cur.push(b)
      bytes += b.length
    }
    if (cur.length > 0) spans.push(cur)
    return spans
  }

  #load(span: RunBlock[]): Promise<Uint8Array[]> {
    const start = span[0]!.offset
    const length = span.reduce((n, b) => n + b.length, 0)
    const key = partKey(this.sessionId, this.index.seq, span[0]!.part, this.#raw)
    const p = this.store.get(key, { offset: start, length }).then(async (obj) => {
      if (!obj) throw new Error(`Run part ${key} is missing`)
      const bytes = await obj.bytes()
      return span.map((b) => bytes.subarray(b.offset - start, b.offset - start + b.length))
    })
    p.catch(() => {})
    return p
  }

  /** Precedence of the current entry. */
  get precedence(): number {
    return this.head?.q ?? this.index.seq
  }

  /** Move to the next entry in range; returns it (undefined at the end). */
  async next(): Promise<E | undefined> {
    for (;;) {
      while (this.#line < this.#lines.length) {
        const line = this.#lines[this.#line++]!
        const e = this.parse(line, this.#private)
        if (!this.#bounds || inBounds(this.#bounds, runKey(e))) return (this.head = e)
      }
      this.#lines = []
      if (this.#blocks.length > 0) {
        const block = this.#blocks.shift()!
        this.#lines = splitLines(this.#raw ? dec.decode(block) : await gunzipText(block))
        this.#line = 0
        continue
      }
      if (this.#span < this.#spans.length) {
        const current = this.#fetch ?? this.#load(this.#spans[this.#span]!)
        this.#span++
        this.#fetch = this.#span < this.#spans.length ? this.#load(this.#spans[this.#span]!) : null
        // The next part's page is read while the last span of this one is used.
        if (!this.#fetch && this.#part < this.#parts.length)
          this.#page ??= this.#loadPage(this.#part)
        this.#blocks = await current
        continue
      }
      if (this.#part >= this.#parts.length) return (this.head = undefined)
      const page = this.#page ?? this.#loadPage(this.#part)
      this.#page = null
      this.#raw = this.#parts[this.#part]!.raw === true
      this.#private = this.#parts[this.#part]!.p === true
      this.#part++
      this.#spans = this.#plan(await page)
      this.#span = 0
      this.#fetch = null
    }
  }
}

/** Entries of one run in order, optionally limited to one type or a range. */
export async function* readRun(
  store: Store,
  sessionId: string,
  index: RunIndex,
  range?: RunRange | KeyRange | string,
): AsyncGenerator<RunEntry> {
  const c = new RunCursor(store, sessionId, index, range)
  for (let e = await c.next(); e; e = await c.next()) yield e
}

type Keyed = { t: string; k: string; q?: number }

/** Cursor order: run key, then the higher precedence first. */
const before = (a: RunCursor<Keyed>, b: RunCursor<Keyed>) =>
  compareRunKeys(a.head!, b.head!) || b.precedence - a.precedence

/** A binary min-heap of cursors. */
class CursorHeap<E extends Keyed> {
  readonly items: RunCursor<E>[] = []
  get size() {
    return this.items.length
  }
  peek(): RunCursor<E> | undefined {
    return this.items[0]
  }
  push(c: RunCursor<E>) {
    const a = this.items
    a.push(c)
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1
      if (before(a[p]!, a[i]!) <= 0) break
      ;[a[p], a[i]] = [a[i]!, a[p]!]
      i = p
    }
  }
  pop(): RunCursor<E> | undefined {
    const a = this.items
    const top = a[0]
    const last = a.pop()
    if (a.length > 0 && last) {
      a[0] = last
      for (let i = 0; ;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && before(a[l]!, a[m]!) < 0) m = l
        if (r < a.length && before(a[r]!, a[m]!) < 0) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i]!, a[m]!]
        i = m
      }
    }
    return top
  }
}

/**
 * K-way merge of any number of runs by (type, id), with a heap. On equal keys
 * the entry with the highest precedence wins, and its precedence is set as `q`
 * so a compacted run keeps it.
 */
export function mergeRuns(
  store: Store,
  sessionId: string,
  indexes: RunIndex[],
  range?: RunRange | KeyRange | string,
): AsyncGenerator<RunEntry> {
  return merge(store, sessionId, indexes, range, (line) => JSON.parse(line) as RunEntry)
}

/** mergeRuns, as lines with only their keys read (readRunLine): for a compaction. */
export function mergeRunLines(
  store: Store,
  sessionId: string,
  indexes: RunIndex[],
  range?: RunRange | KeyRange | string,
): AsyncGenerator<RunLine> {
  return merge(store, sessionId, indexes, range, readRunLine)
}

async function* merge<E extends Keyed>(
  store: Store,
  sessionId: string,
  indexes: RunIndex[],
  range: RunRange | KeyRange | string | undefined,
  parse: (line: string, maybePrivate: boolean) => E,
): AsyncGenerator<E> {
  const spanBytes = Math.max(
    BLOCK_BYTES,
    Math.floor(runConfig.prefetchBudget / (2 * Math.max(1, indexes.length))),
  )
  const heap = new CursorHeap<E>()
  await Promise.all(
    indexes.map(async (ix) => {
      const c = new RunCursor(store, sessionId, ix, range, spanBytes, parse)
      if (await c.next()) heap.push(c)
    }),
  )
  while (heap.size > 0) {
    const top = heap.pop()!
    const winner = top.head!
    const q = top.precedence
    // Every other run holding the same key loses; advance them past it.
    while (heap.size > 0 && compareRunKeys(heap.peek()!.head!, winner) === 0) {
      const c = heap.pop()!
      if (await c.next()) heap.push(c)
    }
    if (await top.next()) heap.push(top)
    yield winner.q === q ? winner : { ...winner, q }
  }
}

/**
 * Merge runs into one new run of the given tier (a compaction), or, with
 * `range`, one key-range piece of it: its parts numbered from `partBase`, no
 * index written (compact.ts joins the pieces).
 */
export async function compactRuns(
  store: Store,
  sessionId: string,
  indexes: RunIndex[],
  seq: number,
  tier: number,
  piece?: { range: KeyRange; partBase: number },
): Promise<RunIndex> {
  const w = new RunWriter(store, sessionId, seq, tier, {
    raw: true,
    ...(piece ? { partBase: piece.partBase, writeIndex: false } : {}),
  })
  for await (const e of mergeRunLines(store, sessionId, indexes, piece?.range)) {
    w.addLine(e)
    await w.drain()
  }
  return w.finish()
}

/** The marks of runs, within a range, sorted and unique: split-key candidates. */
export function runMarks(indexes: RunIndex[], range?: RunRange): string[] {
  const out = new Set<string>()
  const b = range ? boundsOf(range) : undefined
  for (const ix of indexes) {
    for (const p of b ? overlapping(ix.parts, b) : ix.parts) {
      for (const m of p.marks ?? []) if (!b || inBounds(b, m)) out.add(m)
    }
  }
  return [...out].sort(compareUtf8)
}
