/**
 * A repository: one storage location's objects, in the documented layout
 * (docs/protocol-v2.md, "Repository layout"), read and written through a
 * Store. The platform primary, customer mirrors and clones all use this.
 *
 *   nodes/<hash>                          tree node JSON, gzip (hash of the uncompressed bytes)
 *   bodies/<leafHash>.ndjson.gz           the leaf's records, one canonical record per line, in
 *                                         entry order; one or more concatenated gzip members
 *   records/<recordHash>.json.gz          an out-of-line record; its body line is {"$ref":"<hash>"}
 *   schemas/<schemaHash>.json             canonical JSON
 *   roots/<versionDigest>.json            version roots (the hex after "ulv2:")
 *   private/<commitment>.json             private set objects (public+private locations only)
 *   files/<fileHash>                      file bytes
 *   collections/<id>/collection.json      collection description and signing keys
 *   collections/<id>/log/<seq>.json       signed version log entries
 *   collections/<id>/head.json            the latest entry
 *
 * Content-addressed objects are immutable and cached forever: the isolate LRU,
 * then the shared cache, then the bucket. Objects read from a location we don't
 * operate (`trusted: false`) are hash-verified before they are used or cached.
 * How a body is split into gzip members, and which records go out of line, are
 * writer choices; readers handle any of them.
 */
import {
  type DecodedNode,
  decodeNode,
  hashSchema,
  jcs,
  type NodeDesc,
  type NodeSource,
  type PrivateSetObject,
  privateCommitment,
  type RecordEntry,
  recordTree,
  sha256Hex,
  type TreeSink,
  type TreeSpec,
  checkProtocolVersion,
  utf8ByteLength,
  type VersionRoot,
  versionDigest,
  versionHash,
} from '../format.js'
import { compareUtf8 } from '../utf8.js'
import { chunkLines, gunzipChunks, gunzipStream, gunzipText, gzip, splitLines } from './gzip.js'
import {
  type HeldRun,
  leafChunks,
  type LayoutName,
  MissingRecordError,
  type Placed,
  type RecordSet,
  type RecordSets,
  type TypedLeaf,
  recordStore,
  type RecordStore,
  type RecordWriter,
} from './layouts/index.js'
import { Lru } from './lru.js'
import { type Store, type Cache, noCache, putJoined } from './types.js'

/** Records over this size are stored once under records/ (writer policy, not protocol). */
export const OUT_OF_LINE_BYTES = 64 * 1024
/** Raw bytes per gzip member when a leaf body is written in pieces (writer policy). */
export const BODY_MEMBER_BYTES = 4 * 1024 * 1024
/**
 * Stored objects over this size are never put in the shared cache, and a body
 * over it is streamed from the store when read a line at a time, never taken
 * whole from the cache: a leaf of large records can hold hundreds of MB of
 * records (Crossref, 2026-10-16), tens of MB compressed. On Workers a whole
 * cached body also let every compression of the rewritten leaf pile up at once
 * (scripts/memory.ts, PR #47).
 */
export const STREAM_BODY_BYTES = 4 * 1024 * 1024
/**
 * Out-of-line records a streamed body resolves ahead of its reader: each is a
 * read, and one at a time a leaf of large records waits on the store's latency
 * per record. At most `entries` lines wait behind one being resolved, and no more
 * are started once `bytes` of records (their size) are being resolved.
 */
export const resolveAheadConfig = { entries: 16, bytes: 4 * 1024 * 1024 }

export const keys = {
  node: (h: string) => `nodes/${h}`,
  body: (leafHash: string) => `bodies/${leafHash}.ndjson.gz`,
  record: (h: string) => `records/${h}.json.gz`,
  schema: (h: string) => `schemas/${h}.json`,
  root: (versionHashOrDigest: string) =>
    `roots/${versionHashOrDigest.includes(':') ? versionDigest(versionHashOrDigest) : versionHashOrDigest}.json`,
  privateSet: (commitment: string) => `private/${commitment}.json`,
  file: (h: string) => `files/${h}`,
  collection: (id: string) => `collections/${id}/collection.json`,
  logEntry: (id: string, seq: number) => `collections/${id}/log/${seq}.json`,
  head: (id: string) => `collections/${id}/head.json`,
}

const REF_PREFIX = '{"$ref":"'
export const outOfLinePointer = (recordHash: string) => `${REF_PREFIX}${recordHash}"}`
/** The record hash a body line points to, or null for an inline record. */
export const outOfLineHash = (line: string): string | null =>
  line.startsWith(REF_PREFIX) ? (JSON.parse(line) as { $ref: string }).$ref : null

const dec = new TextDecoder()

const sizeOf = (v: unknown) => {
  if (typeof v === 'string') return v.length * 2
  if (v && typeof v === 'object' && 'approxBytes' in v)
    return (v as { approxBytes: number }).approxBytes
  return 1024
}

/** A memory cache for decoded nodes and bodies, of about `bytes`. */
export function repoLru(bytes: number): Lru<unknown> {
  return new Lru<unknown>(bytes, sizeOf)
}

let shared: Lru<unknown> | undefined
/**
 * One memory cache for every repository in the process (a server isolate),
 * created on first use. Repositories get a small private cache unless they ask
 * for this one.
 */
export function sharedLru(bytes = 32 * 1024 * 1024): Lru<unknown> {
  return (shared ??= repoLru(bytes))
}

const DEFAULT_MEMORY_BYTES = 8 * 1024 * 1024

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntegrityError'
  }
}

export interface RepoOptions {
  /** A shared cache for immutable bytes (the Cache API on Workers). None by default. */
  cache?: Cache
  /** Namespaces cache and LRU keys when several locations share them (the location id). */
  scope?: string
  /**
   * True only for locations you operate. Otherwise (the default) every object is
   * hash-verified before it's used or cached.
   */
  trusted?: boolean
  /** The memory cache to use, e.g. `sharedLru()`. */
  lru?: Lru<unknown>
  /** Size of a private memory cache when `lru` isn't given (default 8 MB). */
  memoryBytes?: number
  /**
   * Where record bytes live (record-storage-layout.md): `today` (default) is leaf
   * bodies; `f` is packs found through an index, per collection (`recordScope`).
   * No hash depends on it.
   */
  layout?: LayoutName
  /** Layout F keeps its packs and index per collection: the collection this repository is for. */
  recordScope?: string
  /** `delta` stores a rewritten leaf node as its changes against an earlier full node. */
  nodes?: 'full' | 'delta'
}

/** A stored node that is a delta: `{"b":<base hash>,"p":[tuples put],"d":[keys removed]}`. */
const DELTA_PREFIX = '{"b":"'
/** Whether a stored node's JSON is a delta (node deltas), not the node itself. */
export const isNodeDelta = (stored: string) => stored.startsWith(DELTA_PREFIX)
/** A delta larger than this share of the full node is stored full instead (a new keyframe). */
const DELTA_MAX_SHARE = 0.25

/** Open the repository in a store. */
export function openRepo(store: Store, opts: RepoOptions = {}): Repo {
  return new Repo(store, opts)
}

export class Repo {
  readonly cache: Cache
  readonly lru: Lru<unknown>
  readonly scope: string
  readonly trusted: boolean
  /** Where records live when they aren't in leaf bodies, a store a set (null: today's layout). */
  readonly records: RecordSets | null
  readonly nodeDeltas: boolean
  /** The layout it was opened in, and for layout F the collection (see `reopen`). */
  readonly layout: LayoutName
  readonly recordScope: string | undefined

  constructor(
    readonly blobs: Store,
    opts: RepoOptions = {},
  ) {
    this.cache = opts.cache ?? noCache
    this.lru = opts.lru ?? repoLru(opts.memoryBytes ?? DEFAULT_MEMORY_BYTES)
    this.scope = opts.scope ?? ''
    this.trusted = opts.trusted ?? false
    const layout = opts.layout ?? 'today'
    this.layout = layout
    this.recordScope = opts.recordScope
    this.records = recordStore(
      layout,
      this.lru,
      `${this.scope}/${layout}/${opts.recordScope ?? ''}`,
      opts.recordScope ? { root: blobs, home: opts.recordScope } : undefined,
    )
    this.nodeDeltas = opts.nodes === 'delta'
  }

  /** The same repository opened again with other options (fsck's untrusted copy), its layout kept. */
  reopen(opts: Omit<RepoOptions, 'layout' | 'recordScope' | 'nodes'>): Repo {
    return new Repo(this.blobs, {
      layout: this.layout,
      ...(this.recordScope ? { recordScope: this.recordScope } : {}),
      nodes: this.nodeDeltas ? 'delta' : 'full',
      ...opts,
    })
  }

  #ck(key: string) {
    return `${this.scope}/${key}`
  }

  /** Reads in progress, by what they read: a second caller waits for the first. */
  readonly #pending = new Map<string, Promise<unknown>>()

  #shared<T>(key: string, read: () => Promise<T>): Promise<T> {
    const running = this.#pending.get(key)
    if (running) return running as Promise<T>
    const p = read().finally(() => this.#pending.delete(key))
    this.#pending.set(key, p)
    return p
  }

  /** An immutable object's bytes: shared cache, then the bucket. `verify` runs before caching. */
  #immutable(key: string, verify?: (bytes: Uint8Array) => Promise<void>) {
    return this.#shared(`bytes:${key}`, () => this.#fetch(key, verify))
  }

  async #fetch(
    key: string,
    verify?: (bytes: Uint8Array) => Promise<void>,
  ): Promise<Uint8Array | null> {
    const cached = await this.cache.get(this.#ck(key))
    if (cached) return cached
    const obj = await this.blobs.get(key)
    if (!obj) return null
    const bytes = await obj.bytes()
    if (verify && !this.trusted) await verify(bytes)
    if (bytes.byteLength <= STREAM_BODY_BYTES) await this.cache.put(this.#ck(key), bytes)
    return bytes
  }

  /** A stored body's decompressed chunks: read whole and cached when small, streamed when large. */
  async #bodyChunks(
    key: string,
    leafHash: string,
    onRead?: (r: BodyRead) => void,
  ): Promise<AsyncIterable<Uint8Array>> {
    const cached = await this.cache.get(this.#ck(key), { maxBytes: STREAM_BODY_BYTES })
    if (cached) {
      onRead?.({ leaf: leafHash, from: 'cache', storedBytes: cached.byteLength })
      return gunzipChunks(cached)
    }
    const obj = await this.blobs.get(key)
    if (!obj) throw new Error(`Missing body for leaf ${leafHash}`)
    if (obj.size > STREAM_BODY_BYTES) {
      onRead?.({ leaf: leafHash, from: 'stream', storedBytes: obj.size })
      return gunzipStream(obj.body)
    }
    const bytes = await obj.bytes()
    onRead?.({ leaf: leafHash, from: 'whole', storedBytes: bytes.byteLength })
    await this.cache.put(this.#ck(key), bytes)
    return gunzipChunks(bytes)
  }

  // --- Nodes ---

  async nodeJson(hash: string): Promise<string> {
    const key = keys.node(hash)
    const hit = this.lru.get(this.#ck(key))
    if (typeof hit === 'string') return hit
    return this.#shared(`node:${key}`, () => this.#nodeJson(hash, key))
  }

  async #nodeJson(hash: string, key: string): Promise<string> {
    const bytes = await this.#immutable(key, async (b) => {
      const text = await gunzipText(b)
      // A delta is checked once it's expanded, below.
      if (!text.startsWith(DELTA_PREFIX) && sha256Hex(text) !== hash)
        throw new IntegrityError(`Node ${hash} fails its hash`)
    })
    if (!bytes) throw new Error(`Missing node ${hash}`)
    let json = await gunzipText(bytes)
    const delta = json.startsWith(DELTA_PREFIX)
    this.lru.set(this.#ck(`base:${hash}`), {
      v: delta ? (JSON.parse(json) as { b: string }).b : '',
      approxBytes: 128,
    })
    if (delta) {
      json = await this.#expand(json)
      if (sha256Hex(json) !== hash)
        throw new IntegrityError(`Node ${hash} fails its hash (from a delta)`)
    }
    this.lru.set(this.#ck(key), json)
    return json
  }

  /** A node as stored: full JSON, or a delta. */
  async #storedNode(hash: string): Promise<string> {
    const bytes = await this.#immutable(keys.node(hash))
    if (!bytes) throw new Error(`Missing node ${hash}`)
    return gunzipText(bytes)
  }

  async #expand(stored: string): Promise<string> {
    const d = JSON.parse(stored) as { b: string; p: unknown[][]; d: string[] }
    const tuples = new Map(leafTuples(await this.nodeJson(d.b)).map((t) => [tupleKey(t), t]))
    for (const k of d.d) tuples.delete(k)
    for (const t of d.p) tuples.set(t[0] as string, JSON.stringify(t))
    const keysInOrder = [...tuples.keys()].sort(compareUtf8)
    return '{"e":[' + keysInOrder.map((k) => tuples.get(k)!).join(',') + '],"t":"leaf"}'
  }

  /** The full node a delta of `base` diffs against: `base` itself, or its own base. */
  async deltaBase(hash: string): Promise<string | null> {
    const hit = this.lru.get(this.#ck(`base:${hash}`))
    if (hit) return (hit as { v: string }).v || null
    const stored = await this.#storedNode(hash)
    return stored.startsWith(DELTA_PREFIX) ? (JSON.parse(stored) as { b: string }).b : null
  }

  /**
   * Write a node. With node deltas, a rewritten leaf (`base`: the leaf it replaces)
   * is stored as its changes against the base's full node, while they stay small.
   */
  async putNode(hash: string, json: string, base?: string): Promise<void> {
    let stored = json
    if (this.nodeDeltas && base && json.endsWith('],"t":"leaf"}')) {
      const frame = (await this.deltaBase(base)) ?? base
      const old = new Map(leafTuples(await this.nodeJson(frame)).map((t) => [tupleKey(t), t]))
      const put: unknown[] = []
      const seen = new Set<string>()
      for (const t of leafTuples(json)) {
        const k = tupleKey(t)
        seen.add(k)
        if (old.get(k) !== t) put.push(JSON.parse(t))
      }
      const del = [...old.keys()].filter((k) => !seen.has(k))
      const delta = JSON.stringify({ b: frame, p: put, d: del })
      if (delta.length <= json.length * DELTA_MAX_SHARE) stored = delta
    }
    await this.blobs.put(keys.node(hash), await gzip(stored), {
      contentType: 'application/gzip',
      ifAbsent: true,
    })
  }

  async decoded<E>(spec: TreeSpec<E>, hash: string): Promise<DecodedNode<E>> {
    const key = this.#ck(`decoded:${spec.name}:${hash}`)
    const hit = this.lru.get(key)
    if (hit) return (hit as { node: DecodedNode<E> }).node
    const json = await this.nodeJson(hash)
    // decodeNode checks the hash and the canonical encoding.
    const node = decodeNode(spec, json, hash)
    this.lru.set(key, { node, approxBytes: json.length * 3 })
    return node
  }

  // --- Bodies ---

  /**
   * A leaf's body lines, in entry order, with out-of-line records resolved. On an
   * untrusted location, each line is checked against the leaf's record hashes.
   */
  async bodyLines(
    /** Layout F: with its tree's type, which its records are found by. */
    leaf: Leaf,
    /** Layout F: the set the leaf is in (else public, then private). */
    set?: RecordSet,
  ): Promise<string[]> {
    const key = keys.body(leaf.hash)
    const hit = this.lru.get(this.#ck(key))
    if (hit) return (hit as { lines: string[] }).lines
    // Two readers of one leaf at once decompress it once.
    if (this.records) return this.#shared(`lines:${key}`, () => this.#packedLines(leaf, key, set))
    return this.#shared(`lines:${key}`, () => this.#bodyLines(leaf, key))
  }

  /**
   * Read from the set's record store; a reader that doesn't know the leaf's set
   * tries the public set, then the private one (a miss costs a second lookup).
   */
  async #inSet<T>(set: RecordSet | undefined, read: (r: RecordStore) => Promise<T>): Promise<T> {
    const sets = this.records!
    if (set) return read(sets[set])
    try {
      return await read(sets.public)
    } catch (err) {
      if (!(err instanceof MissingRecordError)) throw err
      return read(sets.private)
    }
  }

  async #packedLines(leaf: Leaf, key: string, set: RecordSet | undefined): Promise<string[]> {
    const lines = await this.#resolve(await this.#inSet(set, (r) => r.leafLines(typed(leaf))))
    this.#checkPacked(leaf, lines)
    this.lru.set(this.#ck(key), { lines, approxBytes: lines.reduce((n, l) => n + l.length * 2, 0) })
    return lines
  }

  /**
   * A packed layout's records come from its packs, not a body the leaf hashes: on an
   * untrusted location (a mirror read by a third party) each line read, resolved, is
   * checked as a body's is, against its entry (`at[j]`, else the j-th).
   */
  #checkPacked(
    leaf: { hash: string; entries: readonly RecordEntry[] },
    lines: readonly string[],
    at?: readonly number[],
  ): void {
    if (this.trusted) return
    lines.forEach((l, j) => {
      const i = at ? at[j]! : j
      const e = leaf.entries[i]!
      if (sha256Hex(l) !== e.hash)
        throw new IntegrityError(`Leaf ${leaf.hash}: record ${i} fails its hash`)
      if (utf8ByteLength(l) !== e.size || !l.startsWith(`{"id":${JSON.stringify(e.key)},"type":`))
        throw new IntegrityError(`Leaf ${leaf.hash}: record ${i} isn't its entry's record`)
    })
  }

  /**
   * Some of a leaf's records (by entry index), resolved. A packed layout reads only
   * those; leaf bodies are read whole (or from memory) and picked from.
   */
  async linesAt(leaf: Leaf, at: readonly number[], set?: RecordSet): Promise<string[]> {
    if (!this.records) {
      const lines = await this.bodyLines(leaf)
      return at.map((i) => lines[i]!)
    }
    const lines = await this.#resolve(await this.#inSet(set, (r) => r.linesAt(typed(leaf), at)))
    this.#checkPacked(leaf, lines, at)
    return lines
  }

  /** One entry's record line (resolved): a changed record's old body, in a packed layout. */
  async entryLine(leaf: Leaf, i: number, set?: RecordSet): Promise<string> {
    if (!this.records) return (await this.bodyLines(leaf))[i]!
    const stored = await this.#inSet(set, (r) => r.entryLine(typed(leaf), i))
    const line = stored.startsWith(REF_PREFIX) ? await this.#outOfLine(stored) : stored
    this.#checkPacked(leaf, [line], [i])
    return line
  }

  async #bodyLines(
    leaf: { hash: string; entries: readonly RecordEntry[] },
    key: string,
  ): Promise<string[]> {
    const check = async (b: Uint8Array) => {
      const lines = await this.#resolve(splitLines(await gunzipText(b)))
      if (lines.length !== leaf.entries.length)
        throw new IntegrityError(`Body of ${leaf.hash}: wrong line count`)
      lines.forEach((l, i) => {
        const e = leaf.entries[i]!
        if (sha256Hex(l) !== e.hash)
          throw new IntegrityError(`Body of ${leaf.hash}: line ${i} fails its hash`)
        // The line must also be the record the entry names: its size and its id.
        if (utf8ByteLength(l) !== e.size || !l.startsWith(`{"id":${JSON.stringify(e.key)},"type":`))
          throw new IntegrityError(`Body of ${leaf.hash}: line ${i} isn't its entry's record`)
      })
    }
    const bytes = await this.#immutable(key, check)
    if (!bytes) throw new Error(`Missing body for leaf ${leaf.hash}`)
    const lines = await this.#resolve(splitLines(await gunzipText(bytes)))
    if (lines.length !== leaf.entries.length) {
      throw new IntegrityError(
        `Body of ${leaf.hash} has ${lines.length} lines for ${leaf.entries.length} entries`,
      )
    }
    this.lru.set(this.#ck(key), { lines, approxBytes: lines.reduce((n, l) => n + l.length * 2, 0) })
    return lines
  }

  /**
   * A leaf's body lines one at a time, out-of-line records resolved, without
   * holding the body decompressed: for rewriting leaves, where one leaf of large
   * records can be tens of MB. Nothing is put in the memory cache, and a stored
   * body over STREAM_BODY_BYTES is streamed from the store, not held or cached.
   * Untrusted locations read through bodyLines, which checks every line before use.
   *
   * With `pointers`, out-of-line records stay the pointer lines they're stored
   * as (trusted locations only): a rewrite stores them as pointers again, so
   * resolving each was a read for nothing, and it wrote the record inline.
   */
  async *bodyLineStream(
    leaf: Leaf,
    onRead?: (r: BodyRead) => void,
    opts: { pointers?: boolean; set?: RecordSet } = {},
  ): AsyncGenerator<string> {
    const key = keys.body(leaf.hash)
    // The memory cache holds lines resolved.
    const hit = opts.pointers && this.trusted ? undefined : this.lru.get(this.#ck(key))
    if (this.records && !hit) {
      // A packed layout: a few MB of records at a time, so a leaf of large records is never held whole.
      for (const at of leafChunks(leaf.entries)) yield* await this.linesAt(leaf, at, opts.set)
      return
    }
    if (hit || !this.trusted) {
      onRead?.({ leaf: leaf.hash, from: hit ? 'memory' : 'whole', storedBytes: null })
      yield* hit ? (hit as { lines: string[] }).lines : await this.bodyLines(leaf)
      return
    }
    let n = 0
    // Lines in order, an out-of-line record's while it resolves.
    const ahead: { line: string | Promise<string>; bytes: number }[] = []
    let resolving = 0
    const next = async () => {
      const a = ahead.shift()!
      resolving -= a.bytes
      return a.line
    }
    for await (const line of chunkLines(await this.#bodyChunks(key, leaf.hash, onRead))) {
      if (++n > leaf.entries.length) break
      if (opts.pointers || !line.startsWith(REF_PREFIX)) ahead.push({ line, bytes: 0 })
      else {
        const bytes = leaf.entries[n - 1]!.size
        while (ahead.length > 0 && resolving + bytes > resolveAheadConfig.bytes) yield await next()
        const resolved = this.#outOfLine(line)
        // Awaited in order below; this only keeps an early failure from going unhandled.
        resolved.catch(() => {})
        ahead.push({ line: resolved, bytes })
        resolving += bytes
      }
      while (ahead.length > resolveAheadConfig.entries) yield await next()
    }
    while (ahead.length > 0) yield await next()
    if (n !== leaf.entries.length) {
      throw new IntegrityError(
        `Body of ${leaf.hash} has ${n} lines for ${leaf.entries.length} entries`,
      )
    }
  }

  /**
   * A leaf body's stored bytes (gzip members), as written: for serving a run of
   * leaves without decoding them. Pointer lines (out-of-line records) stay
   * pointers; callers that need full records use bodyLines.
   */
  async rawBody(leafHash: string): Promise<Uint8Array> {
    if (this.records) throw new Error('rawBody: records are not in leaf bodies in this layout')
    const bytes = await this.#immutable(keys.body(leafHash))
    if (!bytes) throw new Error(`Missing body for leaf ${leafHash}`)
    return bytes
  }

  async #resolve(lines: string[]): Promise<string[]> {
    if (!lines.some((l) => l.startsWith(REF_PREFIX))) return lines
    return Promise.all(lines.map((l) => (l.startsWith(REF_PREFIX) ? this.#outOfLine(l) : l)))
  }

  /** An out-of-line record's canonical JSON, checked against its hash. */
  outOfLineRecord(recordHash: string): Promise<string> {
    return this.#outOfLine(outOfLinePointer(recordHash))
  }

  async #outOfLine(pointer: string): Promise<string> {
    const hash = (JSON.parse(pointer) as { $ref: string }).$ref
    const b = await this.#immutable(keys.record(hash), async (bytes) => {
      if (sha256Hex(await gunzipText(bytes)) !== hash)
        throw new IntegrityError(`Record ${hash} fails its hash`)
    })
    if (!b) throw new Error(`Missing out-of-line record ${hash}`)
    return gunzipText(b)
  }

  /** Write a body from its gzip members (already compressed, in order). */
  async putBody(leafHash: string, members: readonly Uint8Array[]): Promise<void> {
    // Unjoined where the store can: a joined copy doubled a big leaf's write (PR #47).
    await putJoined(this.blobs, keys.body(leafHash), members, {
      contentType: 'application/gzip',
      ifAbsent: true,
    })
  }

  /** Store a large record out of line; returns the pointer line that goes in the body. */
  async putOutOfLine(recordHash: string, canonical: string): Promise<string> {
    await this.blobs.put(keys.record(recordHash), await gzip(canonical), {
      contentType: 'application/gzip',
      ifAbsent: true,
    })
    return outOfLinePointer(recordHash)
  }

  // --- Roots, private sets, schemas ---

  async #json<T>(key: string, verify: (text: string, value: T) => void): Promise<T> {
    const hit = this.lru.get(this.#ck(key))
    if (hit) return (hit as { value: T }).value
    const bytes = await this.#immutable(key, async (b) => {
      const text = dec.decode(b)
      verify(text, JSON.parse(text) as T)
    })
    if (!bytes) throw new Error(`Missing ${key}`)
    const text = dec.decode(bytes)
    const value = JSON.parse(text) as T
    this.lru.set(this.#ck(key), { value, approxBytes: text.length * 3 })
    return value
  }

  /** A version root. Throws UnsupportedProtocolError for a protocol version this package can't read. */
  async root(hash: string): Promise<VersionRoot> {
    const root = await this.#json<VersionRoot>(keys.root(hash), (_t, r) => {
      // The version first: a later protocol hashes roots differently.
      checkProtocolVersion(r)
      if (versionHash(r) !== hash) throw new IntegrityError(`Root ${hash} fails its hash`)
    })
    checkProtocolVersion(root)
    return root
  }

  async putRoot(root: VersionRoot): Promise<string> {
    const hash = versionHash(root)
    await this.blobs.put(keys.root(hash), jcs(root), {
      contentType: 'application/json',
      ifAbsent: true,
    })
    return hash
  }

  privateSet(commitment: string): Promise<PrivateSetObject> {
    return this.#json<PrivateSetObject>(keys.privateSet(commitment), (_t, set) => {
      if (privateCommitment(set) !== commitment)
        throw new IntegrityError(`Private set ${commitment} fails its hash`)
    })
  }

  async putPrivateSet(set: PrivateSetObject): Promise<string> {
    const commitment = privateCommitment(set)
    await this.blobs.put(keys.privateSet(commitment), jcs(set), {
      contentType: 'application/json',
      ifAbsent: true,
    })
    return commitment
  }

  schema(hash: string): Promise<Record<string, unknown>> {
    return this.#json<Record<string, unknown>>(keys.schema(hash), (_t, s) => {
      if (hashSchema(s) !== hash) throw new IntegrityError(`Schema ${hash} fails its hash`)
    })
  }

  async putSchema(schema: unknown): Promise<string> {
    const hash = hashSchema(schema)
    await this.blobs.put(keys.schema(hash), jcs(schema), {
      contentType: 'application/json',
      ifAbsent: true,
    })
    return hash
  }
}

/**
 * How a leaf body was read, for logs: from this isolate's memory, the shared
 * cache, the store whole, or streamed from the store. `storedBytes` is its
 * compressed size, where the read knows it.
 */
export interface BodyRead {
  leaf: string
  from: 'memory' | 'cache' | 'whole' | 'stream'
  storedBytes: number | null
}

/** A record tree's leaf: layout F also needs the tree's type, which its records are found by. */
export interface Leaf {
  hash: string
  entries: readonly RecordEntry[]
  type?: string | undefined
}

function typed(leaf: Leaf): TypedLeaf {
  if (leaf.type === undefined)
    throw new Error(`Leaf ${leaf.hash}: layout F reads records by their tree's type; pass it`)
  return leaf as TypedLeaf
}

/** NodeSource over a repository. Record trees get bodies through `leafEntries`. */
export class RepoSource<E> implements NodeSource<E> {
  constructor(
    readonly spec: TreeSpec<E>,
    readonly repo: Repo,
    readonly opts: {
      onBodyRead?: (r: BodyRead) => void
      /** `leafStream` keeps out-of-line records as pointers (Repo.bodyLineStream). */
      pointers?: boolean
      /** Layout F: the record set this tree is in, so a read looks in its index alone. */
      set?: RecordSet
      /** Layout F: the tree's type, which its records are found by (needed to read any). */
      type?: string
    } = {},
  ) {}

  node(hash: string): Promise<DecodedNode<E>> {
    return this.repo.decoded(this.spec, hash)
  }

  async leafEntries(hash: string): Promise<E[]> {
    const node = await this.node(hash)
    if (node.kind !== 'leaf') throw new Error(`Node ${hash} is not a leaf`)
    if (this.spec !== (recordTree as TreeSpec<unknown>)) return node.entries.slice()
    const entries = node.entries as RecordEntry[]
    const lines = await this.repo.bodyLines({ hash, entries, type: this.opts.type }, this.opts.set)
    return entries.map((e, i) => ({ ...e, body: lines[i]! })) as E[]
  }

  /**
   * Layout F's leaf entries without bodies, for a merge: unchanged records aren't
   * read or written again. Absent for today's layout.
   */
  get sparseStream(): ((hash: string) => AsyncGenerator<E>) | undefined {
    const records = this.repo.records
    if (!records || this.spec !== (recordTree as TreeSpec<unknown>)) return undefined
    return async function* (this: RepoSource<E>, hash: string) {
      const node = await this.node(hash)
      if (node.kind !== 'leaf') throw new Error(`Node ${hash} is not a leaf`)
      for (const e of node.entries as RecordEntry[])
        yield { key: e.key, hash: e.hash, size: e.size } as E
    }.bind(this)
  }

  /** Some of a leaf's entries with bodies, reading only those records (packed layouts only). */
  get payloadsAt():
    | ((leafHash: string, entries: readonly E[], at: readonly number[]) => Promise<E[]>)
    | undefined {
    if (!this.repo.records || this.spec !== (recordTree as TreeSpec<unknown>)) return undefined
    return async (leafHash, entries, at) => {
      const lines = await this.repo.linesAt(
        { hash: leafHash, entries: entries as unknown as RecordEntry[], type: this.opts.type },
        at,
        this.opts.set,
      )
      return at.map((i, j) => ({ ...(entries[i] as unknown as RecordEntry), body: lines[j]! }) as E)
    }
  }

  /** An entry from `sparseStream` with its body: a changed record's old version. */
  async withPayload(leafHash: string, e: E): Promise<E> {
    const node = await this.node(leafHash)
    if (node.kind !== 'leaf') throw new Error(`Node ${leafHash} is not a leaf`)
    const entries = node.entries as RecordEntry[]
    const r = e as unknown as RecordEntry
    const i = entries.findIndex((x) => x.key === r.key)
    return {
      ...r,
      body: await this.repo.entryLine(
        { hash: leafHash, entries, type: this.opts.type },
        i,
        this.opts.set,
      ),
    } as E
  }

  /** A leaf's entries with bodies, one at a time (Repo.bodyLineStream). */
  async *leafStream(hash: string): AsyncGenerator<E> {
    const node = await this.node(hash)
    if (node.kind !== 'leaf') throw new Error(`Node ${hash} is not a leaf`)
    if (this.spec !== (recordTree as TreeSpec<unknown>)) {
      yield* node.entries
      return
    }
    const entries = node.entries as RecordEntry[]
    let i = 0
    for await (const body of this.repo.bodyLineStream(
      { hash, entries, type: this.opts.type },
      this.opts.onBodyRead,
      {
        pointers: this.opts.pointers ?? false,
        ...(this.opts.set ? { set: this.opts.set } : {}),
      },
    )) {
      yield { ...entries[i++]!, body } as E
    }
  }
}

/**
 * TreeSink that writes nodes (and, for record trees, bodies) to a repository.
 * The builder is synchronous; writes run in the background with bounded
 * concurrency. Call `drain()` between units of work and `flush()` before using
 * the root. `written` lists every key written, in order, which is the commit's
 * sync work for mirrors.
 *
 * A body is written once its leaf ends (its key is the leaf hash). Until then,
 * spilled entries are held as compressed gzip members, so a large leaf costs its
 * compressed size in memory rather than its raw size.
 *
 * `drain()` bounds the writes in flight by count and by the raw size of the
 * bodies they carry: sixteen leaves of large records (Crossref works, ~6.5 KB
 * each) are tens of MB, a large share of a Worker's 128 MB.
 */
export class RepoSink<E> implements TreeSink<E> {
  readonly #pending = new Set<Promise<void>>()
  #error: unknown = null
  #members: Promise<Uint8Array>[] = []
  /** Raw body bytes of the members not yet in a leaf's write. */
  #memberBytes = 0
  /** Members still compressing: each holds its raw text until it's done. */
  readonly #compressing = new Set<Promise<unknown>>()
  /** Their raw text length. */
  #compressingBytes = 0
  /** Raw body bytes of the writes in flight. */
  #pendingBytes = 0
  readonly written: string[] = []
  /** Layout F's writer for this sink's records: its set's (null for leaf bodies, or none yet). */
  #records: RecordWriter | null = null
  /** The leaf being rewritten: the base of the next leaf node's delta. */
  #base: string | undefined

  constructor(
    readonly repo: Repo,
    readonly opts: {
      bodyOf?: (e: E) => string
      concurrency?: number
      /** Raw body bytes in flight before `drain()` waits (default 16 MB). */
      pendingBytes?: number
      /** Raw text of members compressing before `settle()` waits (default 2 MB). */
      compressingBytes?: number
      /** Layout F: the record set this sink's records go to (needed to write any). */
      set?: RecordSet
      /** Layout F: the type of the tree being built (needed to write any; see `type`). */
      type?: string
      /** Layout F: hold each run back from the manifest (`held`), for the commit to name. */
      holdRecords?: boolean
    } = {},
  ) {
    this.type = opts.type
  }

  /** Runs held back (`holdRecords`), in the order written. */
  readonly held: HeldRun[] = []

  /**
   * Layout F: the type of the tree being built, which its records are stored under.
   * A sink that builds several types' trees, one after another, is told each.
   */
  type: string | undefined

  /** Layout F's writer for this sink's set, made on first use; null for leaf bodies. */
  get #writer(): RecordWriter | null {
    if (!this.repo.records) return null
    if (!this.opts.set) throw new Error('RepoSink: layout F writes records to a set; pass `set`')
    return (this.#records ??= this.repo.records[this.opts.set].writer({
      hold: this.opts.holdRecords ?? false,
    }))
  }

  rewriting(base: string): void {
    this.#base = base
  }

  #run(key: string, work: () => Promise<void>, bytes = 0) {
    this.#pendingBytes += bytes
    const p = work()
      .catch((err) => {
        this.#error ??= err
      })
      .finally(() => {
        this.#pending.delete(p)
        this.#pendingBytes -= bytes
      })
    this.#pending.add(p)
    this.written.push(key)
  }

  #member(entries: readonly E[]): Promise<Uint8Array> {
    const text = entries.map(this.opts.bodyOf!).join('\n') + '\n'
    this.#memberBytes += text.length
    this.#compressingBytes += text.length
    const p = gzip(text)
    const done = () => {
      this.#compressing.delete(settled)
      this.#compressingBytes -= text.length
    }
    const settled: Promise<unknown> = p.then(done, done) // a failure surfaces when the body is written
    this.#compressing.add(settled)
    return p
  }

  spill(entries: readonly E[]): void {
    if (!this.opts.bodyOf) return
    if (this.repo.records) {
      for (const e of entries) this.#place(e)
      return
    }
    this.#members.push(this.#member(entries))
  }

  /**
   * Store a new record in the packed layout, and note its place on the entry. One an
   * upload already wrote into a pack (`packed`) is only indexed there: its bytes
   * aren't read or written again.
   */
  #place(e: E) {
    const p = e as unknown as Placed
    if (p.loc !== undefined || (p.body === undefined && p.packed === undefined)) return
    if (this.type === undefined)
      throw new Error("RepoSink: layout F stores records by type; set the tree's `type`")
    p.loc =
      p.packed !== undefined
        ? this.#writer!.addPlaced(this.type, p, p.packed)
        : this.#writer!.add(this.type, p, p.body!)
  }

  leaf(desc: NodeDesc, json: string, entries: readonly E[], spilled: number): void {
    // The base is the leaf being rewritten, for this leaf alone: a later one (after
    // reused nodes, or appended) would only be diffed against an unrelated node.
    const base = this.#base
    this.#base = undefined
    this.#run(keys.node(desc.hash), () => this.repo.putNode(desc.hash, json, base))
    if (!this.opts.bodyOf) return
    if (this.repo.records) {
      for (const e of entries.slice(spilled)) this.#place(e)
      return
    }
    const tail = entries.slice(spilled)
    const members = [...this.#members, ...(tail.length > 0 ? [this.#member(tail)] : [])]
    const bytes = this.#memberBytes
    this.#members = []
    this.#memberBytes = 0
    this.#run(
      keys.body(desc.hash),
      async () => this.repo.putBody(desc.hash, await Promise.all(members)),
      bytes,
    )
  }

  interior(desc: NodeDesc, json: string): void {
    this.#run(keys.node(desc.hash), () => this.repo.putNode(desc.hash, json))
  }

  async drain(): Promise<void> {
    await this.#records?.drain?.()
    const limit = this.opts.concurrency ?? 16
    const bytes = this.opts.pendingBytes ?? 16 * 1024 * 1024
    while (this.#pending.size >= limit || (this.#pending.size > 0 && this.#pendingBytes > bytes)) {
      await Promise.race(this.#pending)
    }
    while (this.#compressing.size > 1) await Promise.race(this.#compressing)
    if (this.#error) throw this.#error
  }

  /**
   * At most `compressingBytes` of raw text compressing: two members of a large
   * leaf (1 MB each in a commit unit). In workerd a compression only runs while
   * the isolate waits on I/O, so a leaf read with nothing to wait on (a cached or
   * small base body) otherwise held every member's raw text until the leaf was
   * written: 180 in flight on a 200 MB leaf (PR #47). Bounded by bytes, not
   * count, so the small members of small leaves don't wait in turn.
   */
  settle(): Promise<void> | undefined {
    const limit = this.opts.compressingBytes ?? 2 * 1024 * 1024
    if (this.#compressingBytes <= limit) return undefined
    return (async () => {
      while (this.#compressingBytes > limit) await Promise.race(this.#compressing)
    })()
  }

  async flush(): Promise<void> {
    while (this.#pending.size > 0) await Promise.race(this.#pending)
    if (this.#error) throw this.#error
    if (this.#records) {
      this.held.push(...(await this.#records.finish()))
      this.#records = null
    }
  }

  // Read-only, for measuring what a sink holds (scripts/memory.ts).

  /** Gzip members of the current leaf not yet in a write (compressing or done). */
  get memberCount(): number {
    return this.#members.length
  }
  /** Their raw text length. */
  get memberBytes(): number {
    return this.#memberBytes
  }
  /** Members still compressing, this leaf's or a written leaf's. */
  get compressingCount(): number {
    return this.#compressing.size
  }
  /** Their raw text length. */
  get compressingBytes(): number {
    return this.#compressingBytes
  }
  /** Writes in flight (nodes and bodies). */
  get writeCount(): number {
    return this.#pending.size
  }
  /** Raw body bytes of the writes in flight. */
  get writeBytes(): number {
    return this.#pendingBytes
  }
}

export const bodyOfRecord = (e: RecordEntry): string => {
  if (e.body === undefined) throw new Error(`Record ${e.key} has no body`)
  return e.body
}

/** Payload size for spilling: the body line's length. */
export const recordPayloadBytes = (e: RecordEntry) => e.body?.length ?? 0

/** Clear a record entry's body once it is in a compressed member. */
export const dropRecordBody = (e: RecordEntry) => {
  delete e.body
}

/** A leaf node's entry tuples, as their canonical JSON. */
function leafTuples(json: string): string[] {
  return (JSON.parse(json) as { e: unknown[] }).e.map((t) => JSON.stringify(t))
}

const tupleKey = (tuple: string) => (JSON.parse(tuple) as [string])[0]
