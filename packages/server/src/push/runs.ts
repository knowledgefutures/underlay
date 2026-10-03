/**
 * Sorted runs: how push sessions hold uploaded data until commit (the external
 * sort of edge-redesign-build.md finding 11).
 *
 * Each upload batch becomes one run, sorted by (type, id). A run is a sequence
 * of blocks of about 64 KB of NDJSON, each gzipped on its own and concatenated
 * into part objects of a few MB, in the platform's internal area:
 *
 *   sessions/<sessionId>/runs/<seq>/<part>.ndjson.gz
 *   sessions/<sessionId>/runs/<seq>/index.json      {seq, tier, blocks: [...]}
 *
 * The index gives each block's first and last key, entry count, byte range in
 * its part, and its natural-boundary marks (below). A reader fetches only the
 * blocks overlapping a key range, by range GET, so a commit unit reads its
 * slice of every run without reading the rest.
 *
 * Precedence: an entry's precedence is the seq of the upload it came from
 * (`q`, or the run's seq for an upload run). On equal keys the highest
 * precedence wins: later uploads replace earlier ones. Because precedence is
 * carried per entry, any group of runs can be compacted into one.
 *
 * Compaction happens during upload (compact.ts): when MERGE_FAN_IN runs of one
 * tier accumulate they're merged into one run of the next tier, up to
 * MAX_TIER. Upload batches hold at most 10,000 entries, so a top-tier run holds
 * at most about 2.5M, and a compaction always fits in one job.
 *
 * Memory: a reader holds one block's lines and a bounded prefetch of compressed
 * bytes, so a k-way merge over hundreds of runs stays within a Worker.
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

/** One entry of a run. `k` is the record id, `t` the type. */
export interface RunEntry {
  t: string
  k: string
  /** Record hash (records and manifest runs). */
  h?: string
  /** Format 1 hash the client used, when it differs (negotiate compatibility). */
  lh?: string
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
  /**
   * Natural-boundary marks: run keys of the block's upserts whose id has at
   * least MARK_BITS trailing zeros in its boundary hash. They're the split-key
   * candidates for parallel commit units, about one per 8k entries, so the
   * planner reads no data.
   */
  marks?: string[]
  /** Some upsert in the block was pushed as private. */
  p?: true
}

export interface RunIndex {
  seq: number
  /** 0 for an upload, n for a run compacted from runs of tier n − 1. */
  tier?: number
  blocks: RunBlock[]
}

/** A slice of one type: ids in `(after, through]`; null is unbounded. */
export interface RunRange {
  type: string
  after?: string | null
  through?: string | null
}

export const BLOCK_BYTES = 64 * 1024
export const PART_BYTES = 4 * 1024 * 1024
/** Runs per compaction. */
export const MERGE_FAN_IN = 16
/** Runs of this tier are never compacted again. */
export const MAX_TIER = 2
/** 2^13 = 8,192: about one mark per eight leaves. */
export const MARK_BITS = 13
/** Compressed bytes a merge prefetches, split across its runs. */
const PREFETCH_BUDGET = 8 * 1024 * 1024

/** Sort key: type, then id, by UTF-8 bytes. A NUL separator keeps types apart. */
export const runKey = (e: { t: string; k: string }) => `${e.t}\u0000${e.k}`
export const compareRunKeys = (a: RunEntry, b: RunEntry) =>
  compareUtf8(a.t, b.t) || compareUtf8(a.k, b.k)

const runPrefix = (sessionId: string, seq: number) => `sessions/${sessionId}/runs/${seq}`
const partKey = (sessionId: string, seq: number, part: number) =>
  `${runPrefix(sessionId, seq)}/${part}.ndjson.gz`

/** Is this id a split-key candidate? */
export const isMark = (id: string) => trailingZeros(boundaryBytes(id)) >= MARK_BITS

/** Writes one run block by block. Entries must arrive sorted. */
export class RunWriter {
  readonly #blocks: RunBlock[] = []
  #lines: string[] = []
  #marks: string[] = []
  #private = false
  #first: string | null = null
  #last: string | null = null
  #bytes = 0
  // Blocks are compressed in order on one chain, then appended to the open part.
  #chain: Promise<void> = Promise.resolve()
  #queued = 0
  #part = 0
  #partChunks: Uint8Array[] = []
  #partBytes = 0
  readonly #puts: Promise<void>[] = []

  constructor(
    readonly store: Store,
    readonly sessionId: string,
    readonly seq: number,
    readonly tier = 0,
  ) {}

  add(e: RunEntry): void {
    const key = runKey(e)
    if (this.#last !== null && compareUtf8(this.#last, key) >= 0) {
      throw new Error(`Run entries out of order at ${JSON.stringify(key)}`)
    }
    const line = JSON.stringify(e)
    this.#first ??= key
    this.#last = key
    this.#lines.push(line)
    if (!e.x && isMark(e.k)) this.#marks.push(key)
    if (e.p) this.#private = true
    this.#bytes += line.length
    if (this.#bytes >= BLOCK_BYTES) this.#flushBlock()
  }

  #flushBlock() {
    if (this.#lines.length === 0) return
    const text = this.#lines.join('\n') + '\n'
    const block = {
      first: this.#first!,
      last: this.#last!,
      count: this.#lines.length,
      ...(this.#marks.length > 0 ? { marks: this.#marks } : {}),
      ...(this.#private ? { p: true as const } : {}),
    }
    this.#lines = []
    this.#marks = []
    this.#private = false
    this.#bytes = 0
    this.#first = null
    this.#queued++
    this.#chain = this.#chain.then(async () => {
      const gz = await gzip(text)
      this.#blocks.push({ ...block, part: this.#part, offset: this.#partBytes, length: gz.length })
      this.#partChunks.push(gz)
      this.#partBytes += gz.length
      this.#queued--
      if (this.#partBytes >= PART_BYTES) this.#flushPart()
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
    const key = partKey(this.sessionId, this.seq, this.#part)
    this.#puts.push(this.store.put(key, body, { contentType: 'application/gzip' }))
    this.#part++
    this.#partChunks = []
    this.#partBytes = 0
  }

  /** Bounded memory: callers writing large runs await this between entries. */
  async drain(): Promise<void> {
    if (this.#queued >= 4) await this.#chain
    if (this.#puts.length >= 2) await Promise.all(this.#puts.splice(0))
  }

  async finish(): Promise<RunIndex> {
    this.#flushBlock()
    await this.#chain
    this.#flushPart()
    await Promise.all(this.#puts.splice(0))
    const index: RunIndex = { seq: this.seq, tier: this.tier, blocks: this.#blocks }
    await this.store.put(
      `${runPrefix(this.sessionId, this.seq)}/index.json`,
      JSON.stringify(index),
      {
        contentType: 'application/json',
      },
    )
    return index
  }
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

export async function readRunIndex(
  store: Store,
  sessionId: string,
  seq: number,
): Promise<RunIndex> {
  const obj = await store.get(`${runPrefix(sessionId, seq)}/index.json`)
  if (!obj) throw new Error(`Run ${seq} of session ${sessionId} is missing`)
  return JSON.parse(await obj.text()) as RunIndex
}

const normalize = (range?: RunRange | string): RunRange | undefined =>
  typeof range === 'string' ? { type: range } : range

/** Is the entry inside the range? */
export function inRunRange(range: RunRange, e: { t: string; k: string }): boolean {
  return (
    e.t === range.type &&
    (range.after == null || compareUtf8(e.k, range.after) > 0) &&
    (range.through == null || compareUtf8(e.k, range.through) <= 0)
  )
}

/**
 * The blocks of a run that can hold entries in the range: a contiguous span,
 * found by binary search (blocks are sorted and disjoint).
 */
export function blocksInRange(index: RunIndex, range?: RunRange): RunBlock[] {
  if (!range) return index.blocks
  // Every key of the type sorts after `type\0` and before `type\u0001`.
  const lo = `${range.type}\u0000${range.after ?? ''}`
  const hi = range.through == null ? `${range.type}\u0001` : `${range.type}\u0000${range.through}`
  const hiInclusive = range.through != null
  const blocks = index.blocks
  // The first block whose last key is past `lo`, and the first block starting past `hi`.
  const search = (pred: (b: RunBlock) => boolean) => {
    let a = 0
    let z = blocks.length
    while (a < z) {
      const m = (a + z) >> 1
      if (pred(blocks[m]!)) z = m
      else a = m + 1
    }
    return a
  }
  const start = search((b) => compareUtf8(b.last, lo) > 0)
  const end = search((b) =>
    hiInclusive ? compareUtf8(b.first, hi) > 0 : compareUtf8(b.first, hi) >= 0,
  )
  return blocks.slice(start, Math.max(start, end))
}

/**
 * Reads one run's entries in order, optionally limited to a range. Neighbouring
 * blocks of a part are fetched together, up to `spanBytes` compressed, and the
 * next span is prefetched while the current one is consumed. Only the current
 * block is decompressed, and lines are parsed one at a time.
 */
export class RunCursor {
  readonly #spans: RunBlock[][] = []
  #span = 0
  #fetch: Promise<Uint8Array[]> | null = null
  #blocks: Uint8Array[] = []
  #lines: string[] = []
  #line = 0
  readonly #range: RunRange | undefined
  /** The current entry, or undefined once the run is exhausted. */
  head: RunEntry | undefined

  constructor(
    readonly store: Store,
    readonly sessionId: string,
    readonly index: RunIndex,
    range?: RunRange | string,
    spanBytes = 1024 * 1024,
  ) {
    this.#range = normalize(range)
    let cur: RunBlock[] = []
    let bytes = 0
    for (const b of blocksInRange(index, this.#range)) {
      const prev = cur[cur.length - 1]
      const contiguous = prev && prev.part === b.part && prev.offset + prev.length === b.offset
      if (prev && (!contiguous || bytes + b.length > spanBytes)) {
        this.#spans.push(cur)
        cur = []
        bytes = 0
      }
      cur.push(b)
      bytes += b.length
    }
    if (cur.length > 0) this.#spans.push(cur)
  }

  #load(i: number): Promise<Uint8Array[]> {
    const span = this.#spans[i]!
    const start = span[0]!.offset
    const length = span.reduce((n, b) => n + b.length, 0)
    const key = partKey(this.sessionId, this.index.seq, span[0]!.part)
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
  async next(): Promise<RunEntry | undefined> {
    for (;;) {
      while (this.#line < this.#lines.length) {
        const e = JSON.parse(this.#lines[this.#line++]!) as RunEntry
        if (!this.#range || inRunRange(this.#range, e)) return (this.head = e)
      }
      if (this.#blocks.length > 0) {
        this.#lines = splitLines(await gunzipText(this.#blocks.shift()!))
        this.#line = 0
        continue
      }
      if (this.#span >= this.#spans.length) return (this.head = undefined)
      const current = this.#fetch ?? this.#load(this.#span)
      this.#span++
      this.#fetch = this.#span < this.#spans.length ? this.#load(this.#span) : null
      this.#blocks = await current
    }
  }
}

/** Entries of one run in order, optionally limited to one type or a range. */
export async function* readRun(
  store: Store,
  sessionId: string,
  index: RunIndex,
  range?: RunRange | string,
): AsyncGenerator<RunEntry> {
  const c = new RunCursor(store, sessionId, index, range)
  for (let e = await c.next(); e; e = await c.next()) yield e
}

/** Cursor order: run key, then the higher precedence first. */
const before = (a: RunCursor, b: RunCursor) =>
  compareRunKeys(a.head!, b.head!) || b.precedence - a.precedence

/** A binary min-heap of cursors. */
class CursorHeap {
  readonly items: RunCursor[] = []
  get size() {
    return this.items.length
  }
  peek(): RunCursor | undefined {
    return this.items[0]
  }
  push(c: RunCursor) {
    const a = this.items
    a.push(c)
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1
      if (before(a[p]!, a[i]!) <= 0) break
      ;[a[p], a[i]] = [a[i]!, a[p]!]
      i = p
    }
  }
  pop(): RunCursor | undefined {
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
export async function* mergeRuns(
  store: Store,
  sessionId: string,
  indexes: RunIndex[],
  range?: RunRange | string,
): AsyncGenerator<RunEntry> {
  const spanBytes = Math.max(BLOCK_BYTES, Math.floor(PREFETCH_BUDGET / Math.max(1, indexes.length)))
  const heap = new CursorHeap()
  await Promise.all(
    indexes.map(async (ix) => {
      const c = new RunCursor(store, sessionId, ix, range, spanBytes)
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

/** Merge runs into one new run of the given tier (a compaction). */
export async function compactRuns(
  store: Store,
  sessionId: string,
  indexes: RunIndex[],
  seq: number,
  tier: number,
): Promise<RunIndex> {
  const w = new RunWriter(store, sessionId, seq, tier)
  for await (const e of mergeRuns(store, sessionId, indexes)) {
    w.add(e)
    await w.drain()
  }
  return w.finish()
}

/** The marks of runs, within a range, sorted and unique: split-key candidates. */
export function runMarks(indexes: RunIndex[], range?: RunRange): string[] {
  const out = new Set<string>()
  for (const ix of indexes) {
    for (const b of blocksInRange(ix, range)) {
      for (const m of b.marks ?? []) {
        const sep = m.indexOf('\u0000')
        if (!range || inRunRange(range, { t: m.slice(0, sep), k: m.slice(sep + 1) })) out.add(m)
      }
    }
  }
  return [...out].sort(compareUtf8)
}
