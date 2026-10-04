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
import { gunzipText, gzip, splitLines } from './gzip.js'
import { Lru } from './lru.js'
import { type Store, type Cache, noCache } from './types.js'

/** Records over this size are stored once under records/ (writer policy, not protocol). */
export const OUT_OF_LINE_BYTES = 64 * 1024
/** Raw bytes per gzip member when a leaf body is written in pieces (writer policy). */
export const BODY_MEMBER_BYTES = 4 * 1024 * 1024

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
}

/** Open the repository in a store. */
export function openRepo(store: Store, opts: RepoOptions = {}): Repo {
  return new Repo(store, opts)
}

export class Repo {
  readonly cache: Cache
  readonly lru: Lru<unknown>
  readonly scope: string
  readonly trusted: boolean

  constructor(
    readonly blobs: Store,
    opts: RepoOptions = {},
  ) {
    this.cache = opts.cache ?? noCache
    this.lru = opts.lru ?? repoLru(opts.memoryBytes ?? DEFAULT_MEMORY_BYTES)
    this.scope = opts.scope ?? ''
    this.trusted = opts.trusted ?? false
  }

  #ck(key: string) {
    return `${this.scope}/${key}`
  }

  /** An immutable object's bytes: shared cache, then the bucket. `verify` runs before caching. */
  async #immutable(
    key: string,
    verify?: (bytes: Uint8Array) => Promise<void>,
  ): Promise<Uint8Array | null> {
    const cached = await this.cache.get(this.#ck(key))
    if (cached) return cached
    const obj = await this.blobs.get(key)
    if (!obj) return null
    const bytes = await obj.bytes()
    if (verify && !this.trusted) await verify(bytes)
    await this.cache.put(this.#ck(key), bytes)
    return bytes
  }

  // --- Nodes ---

  async nodeJson(hash: string): Promise<string> {
    const key = keys.node(hash)
    const hit = this.lru.get(this.#ck(key))
    if (typeof hit === 'string') return hit
    const bytes = await this.#immutable(key, async (b) => {
      if (sha256Hex(await gunzipText(b)) !== hash)
        throw new IntegrityError(`Node ${hash} fails its hash`)
    })
    if (!bytes) throw new Error(`Missing node ${hash}`)
    const json = await gunzipText(bytes)
    this.lru.set(this.#ck(key), json)
    return json
  }

  async putNode(hash: string, json: string): Promise<void> {
    await this.blobs.put(keys.node(hash), await gzip(json), {
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
  async bodyLines(leaf: { hash: string; entries: readonly RecordEntry[] }): Promise<string[]> {
    const key = keys.body(leaf.hash)
    const hit = this.lru.get(this.#ck(key))
    if (hit) return (hit as { lines: string[] }).lines
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
   * A leaf body's stored bytes (gzip members), as written: for serving a run of
   * leaves without decoding them. Pointer lines (out-of-line records) stay
   * pointers; callers that need full records use bodyLines.
   */
  async rawBody(leafHash: string): Promise<Uint8Array> {
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
    const total = members.reduce((n, m) => n + m.byteLength, 0)
    const bytes = new Uint8Array(total)
    let off = 0
    for (const m of members) {
      bytes.set(m, off)
      off += m.byteLength
    }
    await this.blobs.put(keys.body(leafHash), bytes, {
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

/** NodeSource over a repository. Record trees get bodies through `leafEntries`. */
export class RepoSource<E> implements NodeSource<E> {
  constructor(
    readonly spec: TreeSpec<E>,
    readonly repo: Repo,
  ) {}

  node(hash: string): Promise<DecodedNode<E>> {
    return this.repo.decoded(this.spec, hash)
  }

  async leafEntries(hash: string): Promise<E[]> {
    const node = await this.node(hash)
    if (node.kind !== 'leaf') throw new Error(`Node ${hash} is not a leaf`)
    if (this.spec !== (recordTree as TreeSpec<unknown>)) return node.entries.slice()
    const entries = node.entries as RecordEntry[]
    const lines = await this.repo.bodyLines({ hash, entries })
    return entries.map((e, i) => ({ ...e, body: lines[i]! })) as E[]
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
 */
export class RepoSink<E> implements TreeSink<E> {
  readonly #pending = new Set<Promise<void>>()
  #error: unknown = null
  #members: Promise<Uint8Array>[] = []
  readonly written: string[] = []

  constructor(
    readonly repo: Repo,
    readonly opts: { bodyOf?: (e: E) => string; concurrency?: number } = {},
  ) {}

  #run(key: string, work: () => Promise<void>) {
    const p = work()
      .catch((err) => {
        this.#error ??= err
      })
      .finally(() => this.#pending.delete(p))
    this.#pending.add(p)
    this.written.push(key)
  }

  #member(entries: readonly E[]): Promise<Uint8Array> {
    const p = gzip(entries.map(this.opts.bodyOf!).join('\n') + '\n')
    p.catch(() => {}) // surfaced when the body is written
    return p
  }

  spill(entries: readonly E[]): void {
    if (this.opts.bodyOf) this.#members.push(this.#member(entries))
  }

  leaf(desc: NodeDesc, json: string, entries: readonly E[], spilled: number): void {
    this.#run(keys.node(desc.hash), () => this.repo.putNode(desc.hash, json))
    if (!this.opts.bodyOf) return
    const tail = entries.slice(spilled)
    const members = [...this.#members, ...(tail.length > 0 ? [this.#member(tail)] : [])]
    this.#members = []
    this.#run(keys.body(desc.hash), async () =>
      this.repo.putBody(desc.hash, await Promise.all(members)),
    )
  }

  interior(desc: NodeDesc, json: string): void {
    this.#run(keys.node(desc.hash), () => this.repo.putNode(desc.hash, json))
  }

  async drain(): Promise<void> {
    const limit = this.opts.concurrency ?? 16
    while (this.#pending.size >= limit) await Promise.race(this.#pending)
    if (this.#error) throw this.#error
  }

  async flush(): Promise<void> {
    while (this.#pending.size > 0) await Promise.race(this.#pending)
    if (this.#error) throw this.#error
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
