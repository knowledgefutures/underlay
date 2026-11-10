/**
 * Deterministic Crossref-shaped records and workloads. A record is a function of
 * (seed, index, version), so the same command always produces the same records
 * and the same version hashes, and a deleted bench folder can be rebuilt.
 *
 * Sizes follow real Crossref slices on this machine (2026-10-16, 50k records each):
 * eLife mean 2.7 KB (p50 1.6, p99 30), PLOS 14 KB, bioRxiv 12 KB, MIT Press 3.9 KB.
 * The whole corpus averages about 6 KB, with a long tail to ~230 KB, which is what
 * the reference-list length below gives.
 */

import { readFileSync, writeFileSync } from 'node:fs'

// --- Randomness ------------------------------------------------------------------------

/** mulberry32: small, seedable, fast. */
export function prng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** FNV-1a over a string. */
export function hash32(s: string): number {
  let h = 2_166_136_261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16_777_619)
  return h >>> 0
}

const mix = (x: number, k: number) => {
  let h = Math.imul(x ^ k, 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return (h ^ (h >>> 16)) & 0xffff
}

/** A 32-bit Feistel permutation keyed by the seed: every index gets its own random-looking number. */
function permute(i: number, seed: number): number {
  let l = (i >>> 16) & 0xffff
  let r = i & 0xffff
  for (let round = 0; round < 4; round++) {
    const next = l ^ mix(r, seed + round * 0x9e3779b9)
    l = r
    r = next
  }
  return ((l << 16) | r) >>> 0
}

// --- Records ---------------------------------------------------------------------------

/** Record types with their share of the corpus (Crossref's own mix, roughly). */
export const TYPES: readonly [string, number][] = [
  ['journal-article', 75],
  ['book-chapter', 12],
  ['proceedings-article', 6],
  ['posted-content', 4],
  ['dataset', 3],
]
const TYPE_TABLE = TYPES.flatMap(([t, w]) => Array<string>(w).fill(t))

/**
 * Publishers: Crossref's DOI prefixes. Records of one prefix sit next to each other
 * in id order and look alike (one publisher's reference lists are long, another's
 * book chapters are tiny), so leaves vary in size the way staging's do: 44–156 MB
 * leaves of long-reference works (2026-10-16), and ranges of tiny chapters. Prefix
 * popularity is skewed: the largest holds about an eighth of all records.
 */
export const PUBLISHERS = 4000
interface Publisher {
  prefix: number
  /** Log of the median reference count for its records. */
  mu: number
  /** Tiny records: no references, no abstract (OED-style chapters). */
  tiny: boolean
  type: string
}
const publishers = new Map<number, Publisher[]>()
function publisherList(seed: number): Publisher[] {
  let list = publishers.get(seed)
  if (list) return list
  // A table per seed, the latest 64 kept: many collections each have a seed, and
  // 20,000 tables (80M objects) ran the bench out of heap. Rebuilt the same if dropped.
  if (publishers.size >= 64) publishers.delete(publishers.keys().next().value!)
  list = Array.from({ length: PUBLISHERS }, (_, rank) => {
    const r = prng(hash32(`${seed}/publisher/${rank}`))
    const tiny = r() < 0.04
    return {
      // 7919 is prime to 9000, so every rank gets its own prefix.
      prefix: 1000 + ((rank * 7919) % 9000),
      mu: 2.35 + 1.0 * normal(r),
      tiny,
      type: tiny ? 'book-chapter' : TYPE_TABLE[Math.floor(r() * 100)]!,
    }
  })
  publishers.set(seed, list)
  return list
}

export function publisherOf(seed: number, i: number): Publisher {
  const u = permute(i, seed ^ 0x2545f491) / 4_294_967_296
  return publisherList(seed)[Math.floor(PUBLISHERS * u ** 4)]!
}

export function idOf(seed: number, i: number): string {
  const p = permute(i, seed)
  return `10.${publisherOf(seed, i).prefix}/b${p.toString(36).padStart(7, '0')}`
}

/** Mostly the publisher's own type, sometimes another (Crossref's mix overall). */
export function typeOf(seed: number, i: number): string {
  const x = permute(i, seed ^ 0x5bd1e995) % 100
  return x < 70 ? publisherOf(seed, i).type : TYPE_TABLE[x]!
}

// 3,000 made-up words, plus some non-ASCII ones: text compresses about as Crossref's does.
const SYLLABLES = ['ka', 'to', 'ri', 'mon', 'sel', 'vu', 'pha', 'en', 'dro', 'gli', 'stu', 'ber']
SYLLABLES.push('nax', 'ul', 'tie', 'ço', 'mü', 'ré', 'son', 'quil', 'za', 'ped', 'ox', 'lin')
const VOCAB = (() => {
  const r = prng(7)
  const syl = () => SYLLABLES[Math.floor(r() * SYLLABLES.length)]!
  const words = Array.from({ length: 3000 }, () =>
    Array.from({ length: 2 + Math.floor(r() * 3) }, syl).join(''),
  )
  return words.concat(['研究', 'データ', 'модель', 'Gesellschaft', 'São', 'Zürich', 'über'])
})()
const PUBLISHER_NAMES = Array.from({ length: 400 }, (_, i) => `Publisher ${VOCAB[i * 7]!} ${i}`)
const JOURNALS = Array.from(
  { length: 5000 },
  (_, i) => `Journal of ${VOCAB[i % 3000]!} ${VOCAB[(i * 13) % 3000]!}`,
)

export interface GenRecord {
  id: string
  type: string
  data: Record<string, unknown>
}

/** Standard normal from two uniforms. */
const normal = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())

/**
 * Record `i` at `version`. The body comes from (seed, i), so a new version keeps
 * the record's size and most of its fields, as Crossref's updates do; the
 * version changes the indexed date, the citation count and the version field.
 */
export function record(seed: number, i: number, version: number): GenRecord {
  const r = prng(hash32(`${seed}/${i}`))
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a))
  const word = () => VOCAB[Math.floor(r() * VOCAB.length)]!
  const words = (n: number) => Array.from({ length: n }, word).join(' ')
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1)
  const doi = idOf(seed, i)
  const type = typeOf(seed, i)
  const year = int(1950, 2027)
  const pub = publisherOf(seed, i)
  // Reference counts are lognormal around the publisher's own median.
  const refs = pub.tiny ? 0 : Math.min(1500, Math.floor(Math.exp(pub.mu + 0.6 * normal(r))))
  const reference = Array.from({ length: refs }, (_, k) => {
    const ry = String(int(1900, year + 1))
    const author = `${cap(word())} ${cap(word())[0]}.`
    const title = words(int(5, 14))
    const journal = JOURNALS[int(0, JOURNALS.length)]!
    const ref: Record<string, string> = {
      key: `${doi.slice(8)}_ref${k}`,
      unstructured: `${author}, ${title}. ${journal} ${int(1, 300)} (${ry}) ${int(1, 2000)}.`,
    }
    if (r() < 0.6) {
      ref.DOI = `10.${int(1000, 9999)}/${Math.floor(r() * 36 ** 6).toString(36)}`
      ref['doi-asserted-by'] = r() < 0.5 ? 'crossref' : 'publisher'
    }
    if (r() < 0.5) {
      ref.author = author
      ref.year = ry
      ref['journal-title'] = journal
    }
    return ref
  })
  const authors = Array.from(
    { length: Math.max(1, Math.floor(Math.exp(1.2 + 0.8 * normal(r)))) },
    (_, k) => ({
      given: cap(word()),
      family: cap(word()),
      sequence: k === 0 ? 'first' : 'additional',
      affiliation: r() < 0.4 ? [{ name: cap(words(int(3, 8))) }] : [],
      ...(r() < 0.3
        ? { ORCID: `https://orcid.org/0000-000${int(1, 9)}-${int(1000, 9999)}-${int(1000, 9999)}` }
        : {}),
    }),
  )
  const publisher = PUBLISHER_NAMES[pub.prefix % PUBLISHER_NAMES.length]!
  const data: Record<string, unknown> = {
    DOI: doi,
    type,
    title: [cap(words(int(5, 18)))],
    author: authors,
    publisher,
    'container-title': [JOURNALS[int(0, JOURNALS.length)]!],
    issued: { 'date-parts': [[year, int(1, 13), int(1, 29)]] },
    ISSN: [`${int(1000, 9999)}-${int(1000, 9999)}`],
    URL: `https://doi.org/${doi}`,
    'reference-count': refs,
    reference,
    // What a new version changes.
    indexed: { 'date-time': `2026-${String(1 + (version % 12)).padStart(2, '0')}-01T00:00:00Z` },
    'is-referenced-by-count': int(0, 50) + version * 3,
    version,
  }
  if (!pub.tiny && r() < 0.35) data.abstract = `<jats:p>${cap(words(int(60, 260)))}.</jats:p>`
  if (r() < 0.5) data.subject = Array.from({ length: int(1, 4) }, () => cap(words(2)))
  if (r() < 0.6)
    data.license = [
      { URL: 'https://creativecommons.org/licenses/by/4.0/', 'content-version': 'vor' },
    ]
  if (r() < 0.4)
    data.funder = [{ name: cap(words(int(2, 6))), award: [String(int(10000, 999999))] }]
  return { id: doi, type, data }
}

/** A schema per type: required fields every generated record meets, so validation does real work. */
export function schemas(): Record<string, unknown> {
  const s = {
    type: 'object',
    required: ['DOI', 'type', 'title', 'publisher', 'issued'],
    properties: {
      DOI: { type: 'string' },
      type: { type: 'string' },
      title: { type: 'array', items: { type: 'string' } },
      author: {
        type: 'array',
        items: {
          type: 'object',
          properties: { given: { type: 'string' }, family: { type: 'string' } },
        },
      },
      publisher: { type: 'string' },
      issued: { type: 'object' },
      reference: { type: 'array', items: { type: 'object' } },
      'reference-count': { type: 'integer' },
      version: { type: 'integer' },
      'container-title': { type: 'array', items: { type: 'string' } },
      ISSN: { type: 'array', items: { type: 'string' } },
      URL: { type: 'string' },
      indexed: { type: 'object' },
      'is-referenced-by-count': { type: 'integer' },
      abstract: { type: 'string' },
      subject: { type: 'array', items: { type: 'string' } },
      license: { type: 'array', items: { type: 'object' } },
      funder: { type: 'array', items: { type: 'object' } },
    },
  }
  return Object.fromEntries(TYPES.map(([t]) => [t, s]))
}

// --- Workloads ---------------------------------------------------------------------------

/**
 * Crossref's daily change rate: about 240k changes over about 180M records. Kept
 * as a fraction, the share of leaves a day touches (~74%) holds at any size.
 */
export const CROSSREF_DAILY_RATE = 240_000 / 180_000_000

/** What a day's changes are made of. */
export interface Mix {
  adds: number
  deletes: number
  reverts: number
}
export const DEFAULT_MIX: Mix = { adds: 0.08, deletes: 0.01, reverts: 0.03 }

export interface Batch {
  /** [index, version] pairs to upsert. */
  upserts: [number, number][]
  /** Indexes to delete. */
  deletes: number[]
}

/**
 * A collection's records as indexes and versions, changed day by day. All of it is
 * replayable from the seed: the same days in the same order give the same state.
 */
export class Workload {
  versions: Uint16Array
  deleted: Uint8Array
  n: number
  live: number

  constructor(
    readonly seed: number,
    initial: number,
    /** Separates a fork's days from its parent's. */
    readonly stream = 'main',
  ) {
    this.n = initial
    this.live = initial
    this.versions = new Uint16Array(Math.max(16, Math.ceil(initial * 1.25)))
    this.deleted = new Uint8Array(this.versions.length)
  }

  /** Keep the state beside a base (a base clones it with its records). */
  save(file: string): void {
    const head = Buffer.from(
      JSON.stringify({
        n: this.n,
        live: this.live,
        stream: this.stream,
        size: this.versions.length,
      }),
    )
    const len = Buffer.alloc(4)
    len.writeUInt32LE(head.length)
    writeFileSync(
      file,
      Buffer.concat([
        len,
        head,
        Buffer.from(this.versions.buffer, this.versions.byteOffset, this.versions.byteLength),
        this.deleted,
      ]),
    )
  }

  static load(file: string, seed: number): Workload {
    const b = readFileSync(file)
    const hl = b.readUInt32LE(0)
    const h = JSON.parse(b.subarray(4, 4 + hl).toString()) as {
      n: number
      live: number
      stream: string
      size: number
    }
    const w = new Workload(seed, 0, h.stream)
    const at = 4 + hl
    w.versions = new Uint16Array(b.buffer.slice(b.byteOffset + at, b.byteOffset + at + h.size * 2))
    w.deleted = new Uint8Array(b.subarray(at + h.size * 2, at + h.size * 3))
    w.n = h.n
    w.live = h.live
    return w
  }

  fork(stream: string): Workload {
    const w = new Workload(this.seed, 0, stream)
    w.n = this.n
    w.live = this.live
    w.versions = this.versions.slice()
    w.deleted = this.deleted.slice()
    return w
  }

  #grow(to: number) {
    if (to <= this.versions.length) return
    const size = Math.ceil(to * 1.25)
    const v = new Uint16Array(size)
    v.set(this.versions)
    const d = new Uint8Array(size)
    d.set(this.deleted)
    this.versions = v
    this.deleted = d
  }

  /** The first load: every record at version 0. */
  *initial(from = 0, to = this.n): Generator<GenRecord> {
    for (let i = from; i < to; i++)
      if (!this.deleted[i]) yield record(this.seed, i, this.versions[i]!)
  }

  /** Append `count` new records (a chunked first load grows this way). */
  add(count: number): [number, number] {
    const from = this.n
    this.#grow(this.n + count)
    this.n += count
    this.live += count
    return [from, this.n]
  }

  /** One day's changes, applied to the state and returned. `rate` is a share of live records. */
  day(day: number, rate = CROSSREF_DAILY_RATE, mix: Mix = DEFAULT_MIX): Batch {
    const r = prng(hash32(`${this.seed}/${this.stream}/day/${day}`))
    const k = Math.max(1, Math.round(this.live * rate))
    const touched = new Set<number>()
    const pickLive = () => {
      for (let tries = 0; tries < 100; tries++) {
        const i = Math.floor(r() * this.n)
        if (!this.deleted[i] && !touched.has(i)) return i
      }
      return -1
    }
    const deletes: number[] = []
    for (let j = 0; j < Math.round(k * mix.deletes); j++) {
      const i = pickLive()
      if (i < 0) continue
      touched.add(i)
      this.deleted[i] = 1
      this.live--
      deletes.push(i)
    }
    const upserts: [number, number][] = []
    for (let j = 0; j < Math.round(k * mix.reverts); j++) {
      const i = pickLive()
      if (i < 0 || this.versions[i] === 0) continue
      touched.add(i)
      this.versions[i] = this.versions[i]! - 1
      upserts.push([i, this.versions[i]!])
    }
    const updates = k - deletes.length - upserts.length - Math.round(k * mix.adds)
    for (let j = 0; j < updates; j++) {
      const i = pickLive()
      if (i < 0) continue
      touched.add(i)
      this.versions[i] = this.versions[i]! + 1
      upserts.push([i, this.versions[i]!])
    }
    const [from, to] = this.add(Math.round(k * mix.adds))
    for (let i = from; i < to; i++) upserts.push([i, 0])
    return { upserts, deletes }
  }

  *records(batch: Batch): Generator<GenRecord> {
    for (const [i, v] of batch.upserts) yield record(this.seed, i, v)
  }

  *deletions(batch: Batch): Generator<{ type: string; id: string }> {
    for (const i of batch.deletes) yield { type: typeOf(this.seed, i), id: idOf(this.seed, i) }
  }

  /** A random live index (reads pick records with it). */
  pick(r: () => number): number {
    for (;;) {
      const i = Math.floor(r() * this.n)
      if (!this.deleted[i]) return i
    }
  }
}
