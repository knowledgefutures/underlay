/**
 * Storage pieces of layout F, records in packs found through an index
 * (record-storage-layout.md). Nothing here changes a hash.
 *
 *   packs     records in blocks of ~64 KB, each block its own gzip member, so one
 *             record costs a range read of one block. A pack is two objects: its
 *             blocks, and a directory of block offsets written when it closes.
 *             Records go in key order, each line `<key>\t<record>` (JSON has
 *             no raw tab), so packs can be merged as streams.
 *   layers    sorted key/value runs in pages of ~16 KB (gzip each), with a
 *             directory of each page's first key and place. An index is a stack
 *             of layers, newest first, merged eight at a time.
 *   manifest  the layers and packs in use: one immutable object per change,
 *             claimed by writing the next sequence number, plus a head hint.
 */
import { compareUtf8 } from '../../utf8.js'
import { gunzipText, gzip } from '../gzip.js'
import type { Lru } from '../lru.js'
import { putJoined, type Store } from '../types.js'

export const BLOCK_RAW = 64 * 1024
export const PACK_RAW = 16 * 1024 * 1024
export const PAGE_RAW = 16 * 1024
/** Small packs of one tier that trigger a merge. */
export const FANOUT = 8
/** Runs of one index level that trigger a merge into the next (fewer layers for a lookup to check). */
export const LAYER_FANOUT = 4
/** Entries a level-0 run holds at most; each level up holds LAYER_FANOUT times more. */
export const LEVEL_BASE = 1024

/**
 * The level a run of `entries` belongs at (size-tiered): a run lands among runs
 * its size, so four small commits merge with each other, not into a large run
 * (an initial load's) that happens to share their level.
 */
export const levelFor = (entries: number) =>
  entries <= LEVEL_BASE
    ? 0
    : Math.ceil(Math.log(entries / LEVEL_BASE) / Math.log(LAYER_FANOUT) - 1e-9)
/** Raw bytes of one file of a merged run: a merge holds one file's pages, never the level's. */
export const RUN_FILE_RAW = 16 * 1024 * 1024
/** Bytes a merge reads from each input at a time, at most. */
const MERGE_READ = 1024 * 1024
/** Bytes a merge reads at a time over all its inputs: each input's share, at least MERGE_READ_MIN. */
export const MERGE_READ_BUDGET = 16 * 1024 * 1024
const MERGE_READ_MIN = 64 * 1024
/** Each input's read size when a merge takes `inputs` streams at once. */
export const mergeRead = (inputs: number) =>
  Math.max(
    MERGE_READ_MIN,
    Math.min(MERGE_READ, Math.floor(MERGE_READ_BUDGET / Math.max(1, inputs))),
  )
/**
 * Blocks of one pack a read takes in one request, at most (neighbours, gaps of up to
 * two): a leaf of large records in a request or two, about 1 MB compressed each.
 */
const READ_BLOCKS = 64
/**
 * Layers an index read works through at once, newest first, of those whose keys
 * overlap it: the ~10 runs a collection usually has in one round of reads.
 */
const READ_LAYERS = 16
/** Pages of one layer a leaf's read has in flight (a typed leaf's range is a few). */
const READ_PAGES = 8

export const newId = () => crypto.randomUUID().replace(/-/g, '')

/** A record's place: pack, block, line in the block. */
export const loc = (pack: string, block: number, line: number) => `${pack}.${block}.${line}`
export const parseLoc = (s: string) => {
  const [pack, block, line] = s.split('.')
  return { pack: pack!, block: Number(block), line: Number(line) }
}

// --- Packs ----------------------------------------------------------------------------

export interface PackInfo {
  id: string
  /** Size tier: 0 for a commit's packs, higher for merged ones. */
  tier: number
  records: number
  /** Stored (compressed) bytes, and raw. */
  bytes: number
  raw: number
  /**
   * The record type the pack holds: a pack closes where the type changes, so no pack
   * spans types and merges take one type's packs. Absent on packs written before.
   */
  type?: string
}

/** The record type a key leads with (recordKey); '' for a key without one. */
const typeOf = (key: string) => {
  const i = key.indexOf('\u0000')
  return i < 0 ? '' : key.slice(0, i)
}

/**
 * Called around each pack's write. An upload records a pack before it's written, so
 * cleanup can find it if the upload dies, and its stats once it is.
 */
export interface PackHooks {
  before?(id: string): Promise<void>
  after?(pack: PackInfo): Promise<void>
}

export class PackWriter {
  #id = ''
  #blocks: Promise<Uint8Array>[] = []
  #lines: string[] = []
  #raw = 0
  #packRaw = 0
  #records = 0
  #lastKey: string | null = null
  #type = ''
  readonly done: PackInfo[] = []
  readonly #writing = new Set<Promise<void>>()
  #error: unknown = null

  constructor(
    readonly store: Store,
    readonly opts: { tier?: number; hooks?: PackHooks } = {},
  ) {}

  /**
   * Add a record line under `key`; returns its place. A key below the last, or of
   * another type, starts a new pack.
   */
  append(key: string, line: string): string {
    const type = typeOf(key)
    if (this.#lastKey !== null && (type !== this.#type || compareUtf8(key, this.#lastKey) < 0))
      this.#close()
    this.#type = type
    this.#lastKey = key
    if (!this.#id) this.#id = newId()
    this.#lines.push(`${key}\t${line}`)
    const at = loc(this.#id, this.#blocks.length, this.#lines.length - 1)
    this.#raw += key.length + line.length + 2
    this.#records++
    if (this.#raw >= BLOCK_RAW) this.#seal()
    if (this.#packRaw >= PACK_RAW) this.#close()
    return at
  }

  get pending(): number {
    return this.#writing.size
  }

  /**
   * Wait while the writer holds too much: a pack still writing beside the one
   * filling, or more than 2 MB of blocks compressing. Merges call it between
   * records, so their output streams out instead of piling up in memory.
   */
  async ready(): Promise<void> {
    while (this.#writing.size > 1) await Promise.race(this.#writing)
    if (this.#blocks.length > 32) await Promise.all(this.#blocks)
    if (this.#error) throw this.#error
  }

  #seal() {
    if (!this.#lines.length) return
    this.#blocks.push(gzip(this.#lines.join('\n') + '\n'))
    this.#packRaw += this.#raw
    this.#lines = []
    this.#raw = 0
  }

  #close() {
    this.#seal()
    this.#lastKey = null
    if (!this.#blocks.length) return
    const job = {
      id: this.#id,
      blocks: this.#blocks,
      records: this.#records,
      raw: this.#packRaw,
      type: this.#type,
    }
    this.#id = ''
    this.#blocks = []
    this.#records = 0
    this.#packRaw = 0
    const p = this.#write(job)
      .catch((err) => {
        this.#error ??= err
      })
      .finally(() => this.#writing.delete(p))
    this.#writing.add(p)
  }

  async #write(job: {
    id: string
    blocks: Promise<Uint8Array>[]
    records: number
    raw: number
    type: string
  }) {
    const parts = await Promise.all(job.blocks)
    const offsets = [0]
    for (const p of parts) offsets.push(offsets.at(-1)! + p.byteLength)
    await this.opts.hooks?.before?.(job.id)
    await putJoined(this.store, packKey(job.id), parts, { ifAbsent: true })
    await this.store.put(packDirKey(job.id), JSON.stringify(offsets), { ifAbsent: true })
    const pack: PackInfo = {
      id: job.id,
      tier: this.opts.tier ?? 0,
      records: job.records,
      bytes: offsets.at(-1)!,
      raw: job.raw,
      ...(job.type ? { type: job.type } : {}),
    }
    this.done.push(pack)
    await this.opts.hooks?.after?.(pack)
  }

  /** Close the current pack and wait for every write. */
  async finish(): Promise<PackInfo[]> {
    this.#close()
    while (this.#writing.size) await Promise.race(this.#writing)
    if (this.#error) throw this.#error
    return this.done
  }
}

export const packKey = (id: string) => `packs/${id}.pk`
export const packDirKey = (id: string) => `packs/${id}.dir`

/** Reads blocks of packs, through the repository's memory cache. */
export class PackReader {
  constructor(
    readonly store: Store,
    readonly lru: Lru<unknown>,
    readonly scope: string,
  ) {}

  async #dir(pack: string): Promise<number[]> {
    const k = `${this.scope}/packdir:${pack}`
    const hit = this.lru.get(k)
    if (hit) return (hit as { v: number[] }).v
    const o = await this.store.get(packDirKey(pack))
    if (!o) throw new Error(`Missing pack directory ${pack}`)
    const v = JSON.parse(await o.text()) as number[]
    this.lru.set(k, { v, approxBytes: v.length * 16 })
    return v
  }

  /** Every line of one block. */
  async block(pack: string, block: number): Promise<string[]> {
    const k = `${this.scope}/block:${pack}.${block}`
    const hit = this.lru.get(k)
    if (hit) return (hit as { v: string[] }).v
    const dir = await this.#dir(pack)
    const from = dir[block]
    const to = dir[block + 1]
    if (from === undefined || to === undefined) throw new Error(`No block ${block} in pack ${pack}`)
    const o = await this.store.get(packKey(pack), { offset: from, length: to - from })
    if (!o) throw new Error(`Missing pack ${pack}`)
    const text = await gunzipText(await o.bytes())
    const v = text.split('\n')
    v.pop()
    for (let i = 0; i < v.length; i++) v[i] = v[i]!.slice(v[i]!.indexOf('\t') + 1)
    this.lru.set(k, { v, approxBytes: text.length * 2 })
    return v
  }

  /**
   * Lines at many places. Blocks are read in runs: neighbouring blocks of one pack
   * (gaps of up to two, READ_BLOCKS at most) come in one range request, as a sorted
   * pack's leaf does. Each block's lines are taken as it's decoded and the block
   * let go (the memory cache may keep it): a leaf whose records are spread over
   * many packs never holds every block it touches.
   */
  async lines(places: readonly string[], concurrency = 8): Promise<string[]> {
    const parsed = places.map(parseLoc)
    const out: (string | undefined)[] = Array.from({ length: parsed.length })
    // Where each block's lines go: (line in block, index in `out`).
    const wants = new Map<string, [number, number][]>()
    const need = new Map<string, Set<number>>()
    parsed.forEach((p, i) => {
      const k = `${p.pack}.${p.block}`
      const hit = this.lru.get(`${this.scope}/block:${k}`)
      if (hit) {
        out[i] = (hit as { v: string[] }).v[p.line]
        if (out[i] === undefined)
          throw new Error(`No line ${p.line} in block ${p.block} of pack ${p.pack}`)
        return
      }
      const w = wants.get(k)
      if (w) w.push([p.line, i])
      else {
        wants.set(k, [[p.line, i]])
        need.set(p.pack, (need.get(p.pack) ?? new Set()).add(p.block))
      }
    })
    const runs: { pack: string; from: number; to: number }[] = []
    for (const [pack, set] of need) {
      const blocks = [...set].sort((x, y) => x - y)
      for (let i = 0; i < blocks.length;) {
        let j = i
        while (
          j + 1 < blocks.length &&
          blocks[j + 1]! - blocks[j]! <= 3 &&
          blocks[j + 1]! - blocks[i]! < READ_BLOCKS
        )
          j++
        runs.push({ pack, from: blocks[i]!, to: blocks[j]! })
        i = j + 1
      }
    }
    const take = (pack: string, b: number, v: string[]) => {
      for (const [line, i] of wants.get(`${pack}.${b}`) ?? []) {
        out[i] = v[line]
        if (out[i] === undefined) throw new Error(`No line ${line} in block ${b} of pack ${pack}`)
      }
    }
    let next = 0
    const worker = async () => {
      while (next < runs.length) await this.#run(runs[next++]!, take)
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, runs.length) }, worker))
    return out as string[]
  }

  /** Blocks `from` through `to` of a pack, in one range read, each handed to `take` as decoded. */
  async #run(
    r: { pack: string; from: number; to: number },
    take: (pack: string, block: number, lines: string[]) => void,
  ) {
    const dir = await this.#dir(r.pack)
    const start = dir[r.from]!
    const o = await this.store.get(packKey(r.pack), {
      offset: start,
      length: dir[r.to + 1]! - start,
    })
    if (!o) throw new Error(`Missing pack ${r.pack}`)
    const bytes = await o.bytes()
    for (let b = r.from; b <= r.to; b++) {
      const text = await gunzipText(bytes.subarray(dir[b]! - start, dir[b + 1]! - start))
      const v = text.split('\n')
      v.pop()
      for (let i = 0; i < v.length; i++) v[i] = v[i]!.slice(v[i]!.indexOf('\t') + 1)
      take(r.pack, b, v)
      this.lru.set(`${this.scope}/block:${r.pack}.${b}`, { v, approxBytes: text.length * 2 })
    }
  }

  /** A whole pack's records in order, with their keys, read `readBytes` at a time (merges and reclaims). */
  async *all(
    pack: string,
    readBytes = MERGE_READ,
  ): AsyncGenerator<{ key: string; line: string; place: string }> {
    const dir = await this.#dir(pack)
    for (let b = 0; b < dir.length - 1;) {
      let e = b
      while (e + 1 < dir.length - 1 && dir[e + 2]! - dir[b]! <= readBytes) e++
      const o = await this.store.get(packKey(pack), {
        offset: dir[b]!,
        length: dir[e + 1]! - dir[b]!,
      })
      if (!o) throw new Error(`Missing pack ${pack}`)
      const bytes = await o.bytes()
      for (let k = b; k <= e; k++) {
        const lines = (
          await gunzipText(bytes.subarray(dir[k]! - dir[b]!, dir[k + 1]! - dir[b]!))
        ).split('\n')
        lines.pop()
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i]!
          const t = l.indexOf('\t')
          yield { key: l.slice(0, t), line: l.slice(t + 1), place: loc(pack, k, i) }
        }
      }
      b = e + 1
    }
  }
}

// --- Layers ---------------------------------------------------------------------------

export interface LayerInfo {
  id: string
  level: number
  /** Manifest sequence it was added in: newer layers win. */
  seq: number
  entries: number
  bytes: number
  min: string
  max: string
  /**
   * The run it belongs to: a merge writes one run as several files in key order,
   * each with its own directory and filter. Absent: a run of one file.
   */
  run?: string
}

export const runOf = (l: LayerInfo) => l.run ?? l.id

/** Layers grouped into runs: files in key order, the run's newest sequence, its level. */
export function runs(
  layers: readonly LayerInfo[],
): { id: string; level: number; seq: number; files: LayerInfo[] }[] {
  const by = new Map<string, LayerInfo[]>()
  for (const l of layers) by.set(runOf(l), [...(by.get(runOf(l)) ?? []), l])
  return [...by].map(([id, files]) => ({
    id,
    level: files[0]!.level,
    seq: Math.max(...files.map((f) => f.seq)),
    files: files.sort((a, b) => compareUtf8(a.min, b.min)),
  }))
}

export const layerKey = (id: string) => `layers/${id}.ly`
export const layerDirKey = (id: string) => `layers/${id}.dir`
export const layerFilterKey = (id: string) => `layers/${id}.bf`

/** What a layer's filter holds for a key: all but its hash (after the last \u0000), or the whole key. */
export const filterKey = (k: string) => {
  const z = k.lastIndexOf('\u0000')
  return z < 0 ? k : k.slice(0, z)
}

/** Two 32-bit hashes of a string (FNV-1a with two seeds), for a Bloom filter. */
function hashes(s: string): [number, number] {
  let a = 2_166_136_261
  let b = 0x9747b28c
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 16_777_619)
    b = Math.imul(b ^ c, 0x5bd1e995)
  }
  return [a >>> 0, (b | 1) >>> 0]
}
const FILTER_BITS = 10
const FILTER_K = 7

/** A Bloom filter of `keys` (~1% false positives). */
export function buildFilter(keys: Iterable<string>, n: number): Uint8Array {
  const h = new FilterHashes()
  for (const k of keys) h.add(k)
  return h.build(n)
}

/**
 * A filter's keys as hash pairs, 8 bytes each, until it's built. Holding the keys
 * themselves would hold far more: a key sliced from a block's text keeps the
 * whole block alive, so a merge's filter kept every input block it had read.
 */
export class FilterHashes {
  #h = new Uint32Array(1024)
  size = 0

  add(k: string): void {
    if (this.size * 2 === this.#h.length) {
      const grown = new Uint32Array(this.#h.length * 2)
      grown.set(this.#h)
      this.#h = grown
    }
    const [h1, h2] = hashes(k)
    this.#h[this.size * 2] = h1
    this.#h[this.size * 2 + 1] = h2
    this.size++
  }

  build(n = this.size): Uint8Array {
    const m = Math.max(1024, n * FILTER_BITS)
    const bits = new Uint8Array(Math.ceil(m / 8) + 4)
    new DataView(bits.buffer).setUint32(0, m)
    for (let j = 0; j < this.size; j++) {
      const h1 = this.#h[j * 2]!
      const h2 = this.#h[j * 2 + 1]!
      for (let i = 0; i < FILTER_K; i++) {
        const bit = (h1 + i * h2) % m
        bits[4 + (bit >>> 3)]! |= 1 << (bit & 7)
      }
    }
    return bits
  }
}

/** A copy of `s` that holds no larger string it was sliced from (V8 keeps the parent of a slice). */
export const detached = (s: string) => (' ' + s).slice(1)

export function filterHas(filter: Uint8Array, k: string): boolean {
  const m = new DataView(filter.buffer, filter.byteOffset).getUint32(0)
  const [h1, h2] = hashes(k)
  for (let i = 0; i < FILTER_K; i++) {
    const bit = (h1 + i * h2) % m
    if (!(filter[4 + (bit >>> 3)]! & (1 << (bit & 7)))) return false
  }
  return true
}

interface LayerDir {
  first: string[]
  off: number[]
}

/** The last page whose first key is ≤ `key` (0 if none is), by binary search. */
function pageAt(dir: LayerDir, key: string): number {
  let lo = 0
  let hi = dir.first.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (compareUtf8(dir.first[mid]!, key) <= 0) lo = mid
    else hi = mid - 1
  }
  return lo
}

export class LayerWriter {
  readonly id = newId()
  #pages: Promise<Uint8Array>[] = []
  #first: string[] = []
  #lines: string[] = []
  #raw = 0
  entries = 0
  #min: string | null = null
  #last: string | null = null
  /** Distinct filter keys' hashes, for the layer's Bloom filter (keys come sorted, so repeats are adjacent). */
  readonly #filtered = new FilterHashes()
  #lastFiltered: string | null = null

  constructor(
    readonly store: Store,
    readonly level: number,
  ) {}

  /** Add in key order (a repeated key keeps the first). */
  add(key: string, value: string): void {
    if (this.#last !== null) {
      const c = compareUtf8(key, this.#last)
      if (c < 0) throw new Error(`Layer keys out of order: ${key} after ${this.#last}`)
      if (c === 0) return
    }
    if (!this.#lines.length) this.#first.push(detached(key))
    this.#min ??= detached(key)
    this.#last = key
    this.#lines.push(`${key}\t${value}`)
    const f = filterKey(key)
    if (f !== this.#lastFiltered) {
      this.#filtered.add(f)
      this.#lastFiltered = f
    }
    this.#raw += key.length + value.length + 2
    this.entries++
    if (this.#raw >= PAGE_RAW) this.#seal()
  }

  #seal() {
    if (!this.#lines.length) return
    this.#pages.push(gzip(this.#lines.join('\n') + '\n'))
    this.#lines = []
    this.#raw = 0
  }

  async finish(seq = 0): Promise<LayerInfo | null> {
    this.#seal()
    if (!this.entries) return null
    const pages = await Promise.all(this.#pages)
    const off = [0]
    for (const p of pages) off.push(off.at(-1)! + p.byteLength)
    await putJoined(this.store, layerKey(this.id), pages, { ifAbsent: true })
    // The directory and the Bloom filter in one object: a cold lookup reads one, not two.
    const dir = new TextEncoder().encode(
      JSON.stringify({ first: this.#first, off } satisfies LayerDir),
    )
    const filter = this.#filtered.build()
    const both = new Uint8Array(4 + dir.byteLength + filter.byteLength)
    new DataView(both.buffer).setUint32(0, dir.byteLength)
    both.set(dir, 4)
    both.set(filter, 4 + dir.byteLength)
    await this.store.put(layerDirKey(this.id), both, { ifAbsent: true })
    return {
      id: this.id,
      level: this.level,
      seq,
      entries: this.entries,
      bytes: off.at(-1)!,
      min: this.#min!,
      max: detached(this.#last!),
    }
  }
}

/**
 * A sorted run written as files of at most RUN_FILE_RAW each, so a merge never
 * holds a level. Its level is at least `level`, and as high as its size puts it.
 */
export class RunWriter {
  readonly id = newId()
  readonly #done: Promise<LayerInfo | null>[] = []
  #file: LayerWriter | null = null
  #raw = 0
  #entries = 0

  constructor(
    readonly store: Store,
    readonly level: number,
  ) {}

  /** Wait while a finished file is still writing: a merge holds at most the one filling and one writing. */
  async ready(): Promise<void> {
    while (this.#done.length > 1) {
      const pending = this.#done.slice(0, -1)
      await Promise.all(pending)
      this.#settled.push(...pending)
      this.#done.splice(0, pending.length)
    }
  }

  /** Files already written, kept until finish. */
  readonly #settled: Promise<LayerInfo | null>[] = []

  add(key: string, value: string): void {
    if (this.#file && this.#raw >= RUN_FILE_RAW) {
      this.#done.push(this.#file.finish())
      this.#file = null
    }
    if (!this.#file) {
      this.#file = new LayerWriter(this.store, this.level)
      this.#raw = 0
    }
    this.#file.add(key, value)
    this.#raw += key.length + value.length + 2
    this.#entries++
  }

  async finish(seq = 0): Promise<LayerInfo[]> {
    if (this.#file) this.#done.push(this.#file.finish())
    this.#file = null
    const files = (await Promise.all([...this.#settled, ...this.#done])).filter(
      (f): f is LayerInfo => f !== null,
    )
    const level = Math.max(this.level, levelFor(this.#entries))
    return files.map((f) => ({
      ...f,
      seq,
      level,
      ...(files.length > 1 ? { run: this.id } : {}),
    }))
  }
}

/** Reads layers a page at a time, through the repository's memory cache. */
export class LayerReader {
  constructor(
    readonly store: Store,
    readonly lru: Lru<unknown>,
    readonly scope: string,
  ) {}

  async #dir(id: string): Promise<LayerDir> {
    const k = `${this.scope}/layerdir:${id}`
    const hit = this.lru.get(k)
    if (hit) return (hit as { v: LayerDir }).v
    const o = await this.store.get(layerDirKey(id))
    if (!o) throw new Error(`Missing layer directory ${id}`)
    const b = await o.bytes()
    let v: LayerDir
    let filter: Uint8Array | null = null
    if (b[0] === 0x7b)
      v = JSON.parse(new TextDecoder().decode(b)) as LayerDir // `{`: an older layer, filter apart
    else {
      const n = new DataView(b.buffer, b.byteOffset).getUint32(0)
      v = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n))) as LayerDir
      filter = b.slice(4 + n)
      this.lru.set(`${this.scope}/filter:${id}`, { v: filter, approxBytes: filter.byteLength })
    }
    this.lru.set(k, { v, approxBytes: v.first.reduce((n, f) => n + f.length * 2 + 16, 0) })
    return v
  }

  async #page(id: string, dir: LayerDir, i: number): Promise<[string, string][]> {
    const k = `${this.scope}/page:${id}.${i}`
    const hit = this.lru.get(k)
    if (hit) return (hit as { v: [string, string][] }).v
    const o = await this.store.get(layerKey(id), {
      offset: dir.off[i]!,
      length: dir.off[i + 1]! - dir.off[i]!,
    })
    if (!o) throw new Error(`Missing layer ${id}`)
    const text = await gunzipText(await o.bytes())
    const v = text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const t = l.indexOf('\t')
        return [l.slice(0, t), l.slice(t + 1)] as [string, string]
      })
    this.lru.set(k, { v, approxBytes: text.length * 3 })
    return v
  }

  async #filter(id: string): Promise<Uint8Array | null> {
    const k = `${this.scope}/filter:${id}`
    const hit = this.lru.get(k)
    if (hit) return (hit as { v: Uint8Array | null }).v
    // The directory carries the filter (newer layers); reading it caches both.
    await this.#dir(id)
    const again = this.lru.get(k)
    if (again) return (again as { v: Uint8Array | null }).v
    const o = await this.store.get(layerFilterKey(id))
    const v = o ? await o.bytes() : null
    this.lru.set(k, { v, approxBytes: v?.byteLength ?? 64 })
    return v
  }

  /**
   * The entries of `keys` (sorted, exact) this layer holds. Only keys its filter
   * may hold are looked for. A few keys read the one page each could be in; more
   * (a leaf's) read the pages from the first such key's to the last's, one at a
   * time, keeping only the keys wanted: a range also holds older versions of the
   * leaf's records, and memory stays a page however many.
   */
  async pick(layer: LayerInfo, keys: readonly string[]): Promise<[string, string][]> {
    const inRange = keys.filter(
      (k) => compareUtf8(layer.min, k) <= 0 && compareUtf8(layer.max, k) >= 0,
    )
    if (!inRange.length) return []
    const filter = await this.#filter(layer.id)
    const maybe = filter ? inRange.filter((k) => filterHas(filter, filterKey(k))) : inRange
    if (!maybe.length) return []
    const dir = await this.#dir(layer.id)
    const want = new Set(maybe)
    const out: [string, string][] = []
    const keep = (page: [string, string][]) => {
      for (const e of page) if (want.has(e[0])) out.push(e)
    }
    if (maybe.length <= 64) {
      const pages = [...new Set(maybe.map((k) => pageAt(dir, k)))]
      for (let i = 0; i < pages.length; i += 8)
        for (const page of await Promise.all(
          pages.slice(i, i + 8).map((p) => this.#page(layer.id, dir, p)),
        ))
          keep(page)
      return out
    }
    const lo = pageAt(dir, maybe[0]!)
    const hi = Math.max(lo, pageAt(dir, maybe.at(-1)!))
    // READ_PAGES in flight, taken in order: a range of a few pages in one round trip.
    const ahead: Promise<[string, string][]>[] = []
    let next = lo
    for (let p = lo; p <= hi; p++) {
      while (next <= hi && next < p + READ_PAGES) ahead.push(this.#page(layer.id, dir, next++))
      keep(await ahead.shift()!)
    }
    return out
  }

  /** The first key of each page, with the page's share of the layer's entries (where to cut it into ranges). */
  async pageKeys(layer: LayerInfo): Promise<{ keys: string[]; perPage: number }> {
    const dir = await this.#dir(layer.id)
    return { keys: dir.first, perPage: layer.entries / Math.max(1, dir.first.length) }
  }

  /**
   * Every entry in order (keys in [from, to) when given), read `readBytes` at a time,
   * bypassing the cache (merges, reclaim's key ranges).
   */
  async *all(
    layer: LayerInfo,
    from?: string,
    to?: string,
    readBytes = MERGE_READ,
  ): AsyncGenerator<[string, string]> {
    if (from !== undefined && compareUtf8(layer.max, from) < 0) return
    if (to !== undefined && compareUtf8(layer.min, to) >= 0) return
    const dir = await this.#dir(layer.id)
    const off = dir.off
    for (let p = from === undefined ? 0 : pageAt(dir, from); p < dir.first.length;) {
      if (to !== undefined && compareUtf8(dir.first[p]!, to) >= 0) return
      let e = p
      while (e + 1 < dir.first.length && off[e + 2]! - off[p]! <= readBytes) e++
      const o = await this.store.get(layerKey(layer.id), {
        offset: off[p]!,
        length: off[e + 1]! - off[p]!,
      })
      if (!o) throw new Error(`Missing layer ${layer.id}`)
      const bytes = await o.bytes()
      for (let k = p; k <= e; k++) {
        for (const l of (
          await gunzipText(bytes.subarray(off[k]! - off[p]!, off[k + 1]! - off[p]!))
        ).split('\n')) {
          if (!l) continue
          const t = l.indexOf('\t')
          const k = l.slice(0, t)
          if (from !== undefined && compareUtf8(k, from) < 0) continue
          if (to !== undefined && compareUtf8(k, to) >= 0) return
          yield [k, l.slice(t + 1)]
        }
      }
      p = e + 1
    }
  }
}

/**
 * A run's entries in order (keys in [from, to) when given): its files one after
 * another, read `readBytes` at a time (`mergeRead` of the merge's input count).
 */
export async function* runEntries(
  reader: LayerReader,
  files: readonly LayerInfo[],
  from?: string,
  to?: string,
  readBytes = MERGE_READ,
): AsyncGenerator<[string, string]> {
  for (const f of files) yield* reader.all(f, from, to, readBytes)
}

/** Merge sorted streams, newest first winning a repeated key. */
export async function* mergeSorted<V>(
  streams: AsyncIterable<[string, V]>[],
): AsyncGenerator<[string, V]> {
  const its = streams.map((s) => s[Symbol.asyncIterator]())
  const heads = await Promise.all(its.map((it) => it.next()))
  for (;;) {
    let best = -1
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i]!
      if (h.done) continue
      if (best < 0 || compareUtf8(h.value[0], (heads[best]!.value as [string, V])[0]) < 0) best = i
    }
    if (best < 0) return
    const key = (heads[best]!.value as [string, V])[0]
    yield heads[best]!.value as [string, V]
    // Skip the same key in older streams (and advance the winner).
    for (let i = 0; i < heads.length; i++) {
      while (!heads[i]!.done && (heads[i]!.value as [string, V])[0] === key)
        heads[i] = await its[i]!.next()
    }
  }
}

// --- Manifest -------------------------------------------------------------------------

export interface Manifest {
  seq: number
  layers: LayerInfo[]
  packs: PackInfo[]
  /** Objects replaced by a merge, deleted once older than the grace period. */
  retired: { key: string; at: number }[]
  /** Counters of merge work. */
  stats: Record<string, number>
  /**
   * Pending objects (F) already folded in, until their deletion is seen: one whose
   * delete failed must never be folded again once its layers are merged away.
   */
  folded?: string[]
  /**
   * The latest commits whose uploads' packs were listed (KeyedLayout.adoptPacks): a
   * retry lists none again, not even one a merge has since taken and swept.
   */
  adopted?: string[]
}

const empty = (): Manifest => ({ seq: 0, layers: [], packs: [], retired: [], stats: {} })
const pad = (n: number) => String(n).padStart(12, '0')

/** The least time between writes of a manifest's head: R2's one write a second a key (tests set it lower). */
export const headConfig = { intervalMs: 1000 }

/**
 * Folded pending objects one manifest update deletes; the rest stay
 * listed in `folded` and go in later updates (a 12M load's 354 units, all in one job's
 * calls, took it past a Worker's 10,000 subrequests).
 */
export const pendingConfig = { deletesPerUpdate: 500 }

/** The sequence a new newest layer takes: past the manifest's number and every layer's. */
export const topSeq = (m: Manifest) => Math.max(m.seq, ...m.layers.map((l) => l.seq))

/** A commit unit's layers and packs, written apart from the manifest until a merge folds them in. */
export interface PendingRun {
  layers: LayerInfo[]
  packs: PackInfo[]
}

/**
 * A pending object: one unit's run, or a commit's (a tree's units' runs, in key
 * order), each folded in as its own run, as if written one an object.
 */
type PendingObject = PendingRun | { runs: PendingRun[] }
const runsOf = (o: PendingObject): PendingRun[] => ('runs' in o ? o.runs : [o])

/** The pending objects a view listed, and which of them it folded in. */
interface Pending {
  listed: string[]
  folded: string[]
}

/**
 * Packs no merge will take again, kept out of the manifest: every reader and
 * writer reads the manifest whole, so a list of every pack there (tens of
 * thousands at Crossref's size) would make each commit and cold read pay for the
 * whole store. They're listed instead in write-once objects that only reclaim
 * reads, and reclaim rewrites as one.
 */
export class PackRegistry {
  constructor(
    readonly store: Store,
    readonly name: string,
  ) {}

  get #prefix() {
    return `manifest/${this.name}/packs/`
  }

  /**
   * List `packs` in a new object; its key (null for none). `name` makes the key
   * fixed, so listing the same packs again (a retried commit) writes nothing.
   */
  async add(packs: readonly PackInfo[], name: string = newId()): Promise<string | null> {
    if (!packs.length) return null
    const key = this.keyFor(name)
    await this.store.put(key, JSON.stringify(packs), { ifAbsent: true })
    return key
  }

  /** The key of the registry object `name`. */
  keyFor(name: string): string {
    return `${this.#prefix}${name}.json`
  }

  async read(): Promise<{ keys: string[]; packs: PackInfo[] }> {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.store.list(this.#prefix, cursor)
      keys.push(...page.keys)
      cursor = page.cursor
    } while (cursor)
    // A pack listed twice (a retried commit naming an upload's packs after a reclaim
    // replaced their object) is one pack.
    const packs = new Map<string, PackInfo>()
    for (let i = 0; i < keys.length; i += 16)
      for (const o of await Promise.all(keys.slice(i, i + 16).map((k) => this.store.get(k))))
        if (o) for (const p of JSON.parse(await o.text()) as PackInfo[]) packs.set(p.id, p)
    return { keys, packs: [...packs.values()] }
  }

  /** Replace the objects `keys` with one listing `packs`. */
  async replace(keys: readonly string[], packs: readonly PackInfo[]): Promise<void> {
    await this.add(packs)
    for (let i = 0; i < keys.length; i += 16)
      await Promise.all(keys.slice(i, i + 16).map((k) => this.store.delete(k)))
  }
}

/** Pending objects this process has written: orders those written in one millisecond. */
let appended = 0

export class ManifestStore {
  #cached: { m: Manifest; at: number } | null = null
  /** Pending objects read, by key: each is written once and never changes. */
  readonly #pendingRuns = new Map<string, PendingObject>()
  /** When the head was last written, as the head says (it's written at most once a second). */
  #headAt = 0
  /** The manifest number the head was last seen or written at. */
  #headSeq = 0

  /**
   * A commit unit's layers and packs go in an object of their own (a new key each),
   * folded into the manifest by the next update, which only merges make (one job
   * at a time per collection). Nothing a commit writes is ever written twice, so no
   * key is written more than once a second however many of a push's units finish
   * together (a manifest object every unit rewrote had 69 such writes in the bench).
   */
  constructor(
    readonly store: Store,
    readonly name: string,
  ) {}

  get #pendingPrefix() {
    return `manifest/${this.name}/pending/`
  }

  /**
   * `m` with the pending runs not yet in it, newest last (keys sort by time), each
   * a sequence past everything in `m`: what the next update will write.
   */
  async #withPending(m: Manifest): Promise<{ m: Manifest; pending: Pending }> {
    const pending: Pending = { listed: [], folded: [] }
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.store.list(this.#pendingPrefix, cursor)
      keys.push(...page.keys)
      cursor = page.cursor
    } while (cursor)
    keys.sort()
    const done = new Set(m.folded ?? [])
    const fresh = keys.filter((k) => !done.has(k))
    pending.listed = keys
    if (!fresh.length) return { m, pending }
    // Read once an isolate: every manifest read sees them all, several times a job.
    const listed = new Set(keys)
    for (const k of this.#pendingRuns.keys()) if (!listed.has(k)) this.#pendingRuns.delete(k)
    const runs: (PendingObject | null)[] = []
    for (let i = 0; i < fresh.length; i += 16)
      runs.push(
        ...(await Promise.all(
          fresh.slice(i, i + 16).map(async (k) => {
            const known = this.#pendingRuns.get(k)
            if (known) return known
            // Folded and deleted since the listing: already in a newer manifest.
            const o = await this.store.get(k)
            if (!o) return null
            const r = JSON.parse(await o.text()) as PendingObject
            this.#pendingRuns.set(k, r)
            return r
          }),
        )),
      )
    const have = new Set(m.layers.map((l) => l.id))
    const havePacks = new Set(m.packs.map((p) => p.id))
    const out = { ...m, layers: [...m.layers], packs: [...m.packs] }
    let seq = topSeq(m)
    for (let i = 0; i < runs.length; i++) {
      const o = runs[i]
      if (!o) continue
      // A run already folded in (an object written twice, or folded before) is skipped.
      for (const r of runsOf(o)) {
        if (r.layers.some((l) => have.has(l.id))) continue
        seq++
        for (const l of r.layers) {
          out.layers.push({ ...l, seq })
          have.add(l.id)
        }
        for (const p of r.packs)
          if (!havePacks.has(p.id)) {
            out.packs.push(p)
            havePacks.add(p.id)
          }
      }
      pending.folded.push(fresh[i]!)
    }
    return { m: out, pending }
  }

  #key(seq: number) {
    return `manifest/${this.name}/${pad(seq)}.json`
  }

  async #read(seq: number): Promise<Manifest | null> {
    if (seq === 0) return empty()
    // Two writers racing for one number can leave a local file store's reader with
    // a cut-short read (it sizes the file, then opens the other writer's): read again.
    for (let attempt = 0; ; attempt++) {
      const o = await this.store.get(this.#key(seq))
      if (!o) return null
      try {
        return JSON.parse(await o.text()) as Manifest & { token?: string }
      } catch (err) {
        if (attempt >= 5) throw err
        await new Promise((r) => setTimeout(r, 10))
      }
    }
  }

  /**
   * The head: the newest manifest as its last writer left it (the whole manifest,
   * so a reader needs one request), or an older head's bare `{seq}`.
   */
  async #head(): Promise<Manifest | null> {
    for (let attempt = 0; ; attempt++) {
      const h = await this.store.get(`manifest/${this.name}/head.json`)
      if (!h) return null
      try {
        const v = JSON.parse(await h.text()) as Partial<Manifest> & { seq: number; at?: number }
        this.#headAt = v.at ?? 0
        this.#headSeq = v.seq
        if (v.layers) return v as Manifest
        return (await this.#read(v.seq)) ?? empty()
      } catch (err) {
        // A local file store can cut a read short while the head is replaced (see #read).
        if (attempt >= 5) throw err
        await new Promise((r) => setTimeout(r, 10))
      }
    }
  }

  /** The newest manifest: the head, then any claimed after it (a writer may not have moved the head yet). */
  async latest(): Promise<Manifest> {
    return (await this.#latest()).m
  }

  async #latest(): Promise<{ m: Manifest; pending: Pending; stored: Manifest }> {
    // The head moves at most once a second, so it can be many manifests behind: find
    // the newest by listing them (a few dozen keys), not from the head.
    let m = await this.#listed()
    for (;;) {
      const next = await this.#read(m.seq + 1)
      if (!next) break
      m = next
    }
    const v = await this.#withPending(m)
    this.#cached = { m: v.m, at: Date.now() }
    return { ...v, stored: m }
  }

  /** The newest manifest by listing their numbers. */
  async #listed(): Promise<Manifest> {
    const prefix = `manifest/${this.name}/0`
    for (let attempt = 0; ; attempt++) {
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const page = await this.store.list(prefix, cursor)
        keys.push(...page.keys)
        cursor = page.cursor
      } while (cursor)
      const top = keys.sort().at(-1)
      if (!top) return empty()
      const m = await this.#read(Number(top.slice(`manifest/${this.name}/`.length, -5)))
      // Deleted as old history between the listing and the read: list again.
      if (m || attempt >= 5) return m ?? empty()
    }
  }

  /**
   * Bring the head up to the newest manifest, waiting out R2's second a key if it
   * was just written. Every job that changes the manifest ends with it, so readers'
   * heads are never left behind.
   */
  async settle(): Promise<void> {
    const { stored } = await this.#latest()
    if (stored.seq === 0) return
    await this.#moveHead(stored, true)
  }

  /**
   * Write the head as `m`, at most once a second whoever writes it.
   * Split merges' swaps, reclaim and forks write it from their own jobs, beside the
   * maintain job, so when it was last written is read from the head itself: an
   * isolate that hadn't read it would think it free (round 17: a write R2 would
   * refuse). With `wait`, a head written under a second ago is waited out; without,
   * it's left for the job's settle. A head left behind costs readers a listing,
   * never a record, so a refused write isn't the job's failure.
   */
  async #moveHead(m: Manifest, wait: boolean): Promise<void> {
    // This isolate wrote or read it under a second ago: it's no older in storage.
    if (!wait && Date.now() - this.#headAt < headConfig.intervalMs) return
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.#head()
      if (this.#headSeq >= m.seq) return
      const left = headConfig.intervalMs - (Date.now() - this.#headAt)
      if (left > 0) {
        if (!wait) return
        // Then read it again: another job waiting on the same head may have moved it.
        // A random share of a second more, so jobs waiting together don't wake together.
        await new Promise((r) => setTimeout(r, left + (Math.random() * headConfig.intervalMs) / 2))
        continue
      }
      const now = Date.now()
      try {
        await this.store.put(`manifest/${this.name}/head.json`, JSON.stringify({ ...m, at: now }))
      } catch {
        return
      }
      this.#headAt = now
      this.#headSeq = m.seq
      return
    }
  }

  /**
   * The manifest for a reader: this isolate's copy when younger than `maxAgeMs`,
   * else the head alone (one request). A reader that misses a record asks
   * `latest()`, which also checks for newer ones.
   */
  async current(maxAgeMs = 2000): Promise<Manifest> {
    if (this.#cached && Date.now() - this.#cached.at < maxAgeMs) return this.#cached.m
    // A writer wants the newest: the head may be behind.
    if (maxAgeMs === 0) return this.latest()
    const m = (await this.#head()) ?? empty()
    this.#cached = { m, at: Date.now() }
    return m
  }

  /**
   * A commit's runs, held back by its units (a tree's, in key order), as one pending
   * object: a push of thousands of units leaves a few objects, not one a unit.
   */
  async appendRuns(runs: PendingRun[]): Promise<void> {
    if (!runs.length) return
    // A retry (assembly appended them, then stopped before saving its tree) names them
    // once only: a second object, folded in after the first's layers merged away, would
    // bring them back as the newest run, of files swept since. A tree's runs go in one
    // object, all or none, so they were named if the index lists any of their layers
    // (pending ones included) or retired one, or its files are gone (swept: a unit's
    // layer files are deleted no other way).
    const m = await this.latest()
    const known = new Set([...m.layers.map((l) => layerKey(l.id)), ...m.retired.map((r) => r.key)])
    if (runs.some((r) => r.layers.some((l) => known.has(layerKey(l.id))))) return
    const first = runs.find((r) => r.layers.length)?.layers[0]
    if (first && !(await this.store.head(layerDirKey(first.id)))) return
    await this.#putPending({ runs })
  }

  /** Add a commit unit's new layers (the newest) and packs, as a pending object of its own. */
  async append(layers: LayerInfo[], packs: PackInfo[]): Promise<void> {
    await this.#putPending({ layers, packs })
  }

  async #putPending(o: PendingObject): Promise<void> {
    // Keys sort by time: a later commit's runs fold in after (and win over) an earlier's.
    // Within a millisecond, by this process's count: two commits a process makes in
    // one millisecond (tests) would otherwise fold in their random ids' order.
    const key = `${this.#pendingPrefix}${String(Date.now()).padStart(15, '0')}-${String(++appended).padStart(9, '0')}-${newId()}.json`
    await this.store.put(key, JSON.stringify(o), { ifAbsent: true })
    this.#cached = null
  }

  /** Apply `change` to the newest manifest and claim the next number; again on a race. */
  async update(change: (m: Manifest) => Manifest | null): Promise<Manifest> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { m, pending } = await this.#latest()
      const next = change(structuredClone(m))
      if (!next) return m
      next.seq = m.seq + 1
      // Folded before and still there (a delete not yet seen), and folded now.
      const listed = new Set(pending.listed)
      next.folded = [...(m.folded ?? []).filter((k) => listed.has(k)), ...pending.folded]
      const token = newId()
      await this.store.put(this.#key(next.seq), JSON.stringify({ ...next, token }), {
        ifAbsent: true,
      })
      const back = (await this.#read(next.seq)) as (Manifest & { token?: string }) | null
      if (back?.token !== token) {
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)))
        continue
      }
      // The head carries the whole manifest: readers need one request. It's written at
      // most once a second (R2's limit a key): a reader whose head is behind finds the
      // newer manifests by number, and misses send it there.
      await this.#moveHead(next, false)
      this.#cached = { m: next, at: Date.now() }
      // Some at a time: those left stay in `folded` (still listed) for the next update.
      const gone = next.folded.slice(0, pendingConfig.deletesPerUpdate)
      for (let i = 0; i < gone.length; i += 16)
        await Promise.all(gone.slice(i, i + 16).map((k) => this.store.delete(k)))
      // Older manifests are history nobody reads: keep the last 25 or so.
      if (next.seq % 25 === 0)
        for (let s = Math.max(1, next.seq - 50); s <= next.seq - 25; s++)
          await this.store.delete(this.#key(s))
      return next
    }
    throw new Error(`Manifest ${this.name}: too many concurrent updates`)
  }
}

/** The index a stack of layers forms: newest wins. */
export class LayeredIndex {
  readonly reader: LayerReader

  constructor(
    readonly store: Store,
    readonly lru: Lru<unknown>,
    readonly scope: string,
    readonly manifests: ManifestStore,
    readonly filter: (l: LayerInfo) => boolean = () => true,
  ) {
    this.reader = new LayerReader(store, lru, scope)
  }

  /**
   * Values of `keys` (exact), newest layer winning, from manifest `m`: READ_LAYERS
   * layers at a time, newest first, until every key is found. Memory is the keys'
   * values and a few layers' pages, however many layers there are (a large push
   * leaves hundreds until merges catch up).
   */
  async values(m: Manifest, keys: Iterable<string>): Promise<Map<string, string>> {
    const sorted = [...new Set(keys)].sort(compareUtf8)
    const out = new Map<string, string>()
    if (!sorted.length) return out
    // Only layers whose keys overlap the read's (from the manifest: no reads).
    const lo = sorted[0]!
    const hi = sorted.at(-1)!
    const layers = m.layers
      .filter((l) => this.filter(l) && compareUtf8(l.min, hi) <= 0 && compareUtf8(l.max, lo) >= 0)
      .sort((a, b) => b.seq - a.seq)
    for (let i = 0; i < layers.length && out.size < sorted.length; i += READ_LAYERS) {
      const left = out.size ? sorted.filter((k) => !out.has(k)) : sorted
      const got = await Promise.all(
        layers.slice(i, i + READ_LAYERS).map((l) => this.reader.pick(l, left)),
      )
      for (const r of got) for (const [k, v] of r) if (!out.has(k)) out.set(k, v)
    }
    return out
  }
}
