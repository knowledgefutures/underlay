/**
 * Reference-log segments: immutable, sorted by hash, in the platform's internal
 * area (never mirrored).
 *
 *   refs/seg/<id>.dat   gzip blocks of NDJSON events, concatenated (~1,024 events each)
 *   refs/seg/<id>.idx   {count, bytes, blocks: [[first, last, offset, length]], m, k, bloom}
 *
 * The index is small (about 1.3 MB of filter at the 256k-event cap) and
 * immutable, so it's cached; a lookup that passes the Bloom filter reads one
 * block by range.
 */
import { gunzipText, gzip, splitLines } from '@underlay/repo'

import type { BlobStore, Cache } from '../ports.js'

/** [hash, kind, collectionId, set, seq, op, type, id]. kind: r(ecord) | f(ile). op: + | -. */
export type RefEvent = [
  string,
  'r' | 'f',
  string,
  'public' | 'private',
  number,
  '+' | '-',
  string,
  string,
]

export const SEGMENT_MAX_EVENTS = 262_144
const BLOCK_EVENTS = 1024
const BLOOM_BITS_PER_KEY = 10
const BLOOM_K = 7

const enc = new TextEncoder()
/** Billable bytes: the event's canonical encoding (a pure function of the event). */
export const eventBytes = (e: RefEvent) => enc.encode(JSON.stringify(e)).byteLength

export const compareEvents = (a: RefEvent, b: RefEvent) =>
  a[0] < b[0]
    ? -1
    : a[0] > b[0]
      ? 1
      : a[2] < b[2]
        ? -1
        : a[2] > b[2]
          ? 1
          : a[4] - b[4] || (a[5] < b[5] ? -1 : a[5] > b[5] ? 1 : 0)

export interface SegmentIndex {
  count: number
  bytes: number
  blocks: [string, string, number, number][]
  m: number
  k: number
  bloom: string
}

const keyOf = (id: string, ext: 'dat' | 'idx') => `refs/seg/${id}.${ext}`

function bloomPositions(hash: string, m: number, k: number): number[] {
  const h1 = parseInt(hash.slice(0, 8), 16)
  // `| 1` alone would make values ≥ 2^31 negative (int32); keep them unsigned.
  const h2 = (parseInt(hash.slice(8, 16), 16) | 1) >>> 0
  return Array.from({ length: k }, (_, i) => (h1 + i * h2) % m)
}

export function bloomHas(idx: SegmentIndex, bits: Uint8Array, hash: string): boolean {
  return bloomPositions(hash, idx.m, idx.k).every((p) => (bits[p >> 3]! & (1 << (p & 7))) !== 0)
}

export interface WrittenSegment {
  id: string
  firstHash: string
  lastHash: string
  count: number
  bytes: number
}

/** Writes sorted events as segments of at most SEGMENT_MAX_EVENTS. */
export class SegmentWriter {
  readonly segments: WrittenSegment[] = []
  #blocks: Uint8Array[] = []
  #blockIndex: [string, string, number, number][] = []
  #offset = 0
  #lines: string[] = []
  #first: string | null = null
  #last: string | null = null
  #blockFirst: string | null = null
  #count = 0
  #bytes = 0
  #prefixes: number[] = []
  #n = 0

  constructor(
    readonly store: BlobStore,
    readonly idFor: (n: number) => string,
  ) {}

  async add(e: RefEvent): Promise<void> {
    if (this.#last !== null && e[0] < this.#last) throw new Error('Reference events out of order')
    const line = JSON.stringify(e)
    this.#first ??= e[0]
    this.#blockFirst ??= e[0]
    this.#last = e[0]
    this.#lines.push(line)
    this.#count++
    this.#bytes += enc.encode(line).byteLength
    this.#prefixes.push(parseInt(e[0].slice(0, 8), 16), parseInt(e[0].slice(8, 16), 16))
    if (this.#lines.length >= BLOCK_EVENTS) await this.#flushBlock()
    if (this.#count >= SEGMENT_MAX_EVENTS) await this.#finishSegment()
  }

  async #flushBlock() {
    if (this.#lines.length === 0) return
    const gz = await gzip(this.#lines.join('\n') + '\n')
    this.#blockIndex.push([this.#blockFirst!, this.#last!, this.#offset, gz.byteLength])
    this.#blocks.push(gz)
    this.#offset += gz.byteLength
    this.#lines = []
    this.#blockFirst = null
  }

  async #finishSegment() {
    await this.#flushBlock()
    if (this.#count === 0) return
    const id = this.idFor(this.#n++)
    const m = Math.max(64, this.#count * BLOOM_BITS_PER_KEY)
    const bits = new Uint8Array(Math.ceil(m / 8))
    for (let i = 0; i < this.#prefixes.length; i += 2) {
      const h1 = this.#prefixes[i]!
      const h2 = (this.#prefixes[i + 1]! | 1) >>> 0
      for (let j = 0; j < BLOOM_K; j++) {
        const p = (h1 + j * h2) % m
        bits[p >> 3]! |= 1 << (p & 7)
      }
    }
    const dat = new Uint8Array(this.#offset)
    let off = 0
    for (const b of this.#blocks) {
      dat.set(b, off)
      off += b.byteLength
    }
    const idx: SegmentIndex = {
      count: this.#count,
      bytes: this.#bytes,
      blocks: this.#blockIndex,
      m,
      k: BLOOM_K,
      bloom: Buffer.from(bits).toString('base64'),
    }
    await this.store.put(keyOf(id, 'dat'), dat, { contentType: 'application/gzip' })
    await this.store.put(keyOf(id, 'idx'), JSON.stringify(idx), { contentType: 'application/json' })
    this.segments.push({
      id,
      firstHash: this.#first!,
      lastHash: this.#last!,
      count: this.#count,
      bytes: this.#bytes,
    })
    this.#blocks = []
    this.#blockIndex = []
    this.#offset = 0
    this.#first = null
    this.#count = 0
    this.#bytes = 0
    this.#prefixes = []
  }

  async finish(): Promise<WrittenSegment[]> {
    await this.#finishSegment()
    return this.segments
  }
}

const idxCache = new Map<string, { idx: SegmentIndex; bits: Uint8Array }>()

async function loadIndex(store: BlobStore, cache: Cache, id: string) {
  const hit = idxCache.get(id)
  if (hit) return hit
  const key = `refidx/${id}`
  let bytes = await cache.get(key)
  if (!bytes) {
    const obj = await store.get(keyOf(id, 'idx'))
    if (!obj) throw new Error(`Missing reference segment index ${id}`)
    bytes = await obj.bytes()
    await cache.put(key, bytes)
  }
  const idx = JSON.parse(new TextDecoder().decode(bytes)) as SegmentIndex
  const entry = { idx, bits: new Uint8Array(Buffer.from(idx.bloom, 'base64')) }
  if (idxCache.size > 256) idxCache.delete(idxCache.keys().next().value!)
  idxCache.set(id, entry)
  return entry
}

/** Events for one hash in one segment. */
export async function lookupSegment(
  store: BlobStore,
  cache: Cache,
  id: string,
  hash: string,
): Promise<RefEvent[]> {
  const { idx, bits } = await loadIndex(store, cache, id)
  if (!bloomHas(idx, bits, hash)) return []
  const out: RefEvent[] = []
  for (const [first, last, offset, length] of idx.blocks) {
    if (hash < first || hash > last) continue
    const obj = await store.get(keyOf(id, 'dat'), { offset, length })
    if (!obj) throw new Error(`Missing reference segment ${id}`)
    for (const line of splitLines(await gunzipText(await obj.bytes()))) {
      const e = JSON.parse(line) as RefEvent
      if (e[0] === hash) out.push(e)
    }
  }
  return out
}

/** All events of a segment in order, a block at a time (for compaction). */
export async function* readSegment(
  store: BlobStore,
  id: string,
  range?: { from: string; to: string },
): AsyncGenerator<RefEvent> {
  const obj = await store.get(keyOf(id, 'idx'))
  if (!obj) throw new Error(`Missing reference segment index ${id}`)
  const idx = JSON.parse(await obj.text()) as SegmentIndex
  for (const [first, last, offset, length] of idx.blocks) {
    if (range && (last < range.from || first >= range.to)) continue
    const block = await store.get(keyOf(id, 'dat'), { offset, length })
    if (!block) throw new Error(`Missing reference segment ${id}`)
    for (const line of splitLines(await gunzipText(await block.bytes()))) {
      const e = JSON.parse(line) as RefEvent
      if (range && (e[0] < range.from || e[0] >= range.to)) continue
      yield e
    }
  }
}

export async function deleteSegment(store: BlobStore, id: string): Promise<void> {
  await store.delete(keyOf(id, 'dat'))
  await store.delete(keyOf(id, 'idx'))
}
