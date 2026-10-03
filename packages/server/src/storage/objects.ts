/**
 * The object layout in the blob store, and typed access to it.
 *
 *   nodes/<hash>              tree node JSON, gzip (the hash is of the uncompressed bytes)
 *   bodies/<leafHash>         the leaf's records, one canonical record per line, one gzip member;
 *                             or, for a leaf over BODY_PART_BYTES, a JSON part list {"parts":[…]}
 *   bodyparts/<hash>          one part of a large leaf body, gzip (hash of the uncompressed part)
 *   records/<recordHash>      an out-of-line record over OUT_OF_LINE_BYTES, gzip;
 *                             its body line is {"$ref":"<recordHash>"}
 *   roots/<digest>.json       version roots
 *   private/<commitment>.json private set objects
 *   schemas/<hash>.json       schemas, as canonical JSON
 *   sessions/<id>/…           push session inputs and runs (expire by lifecycle rule)
 *   files/…, uploads/<uuid>   file bytes (unchanged from v1)
 *
 * Everything except sessions/ and uploads/ is immutable and keyed by content, so
 * it is cached by key forever: the isolate LRU first, then the shared cache, then
 * the bucket. Storage layout (part sizes, out-of-line records) is not protocol.
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
  type VersionRoot,
  versionDigest,
  versionHash,
} from '@underlay/core'

import { gunzip, gunzipText, gzip, isGzip, splitLines } from '../lib/gzip.js'
import { Lru } from '../lib/lru.js'
import type { BlobStore, Cache } from '../ports.js'

export const OUT_OF_LINE_BYTES = 64 * 1024
export const BODY_PART_BYTES = 8 * 1024 * 1024

export const keys = {
  node: (h: string) => `nodes/${h}`,
  body: (h: string) => `bodies/${h}`,
  part: (h: string) => `bodyparts/${h}`,
  record: (h: string) => `records/${h}`,
  root: (versionHashOrDigest: string) =>
    `roots/${versionHashOrDigest.includes(':') ? versionDigest(versionHashOrDigest) : versionHashOrDigest}.json`,
  privateSet: (commitment: string) => `private/${commitment}.json`,
  schema: (h: string) => `schemas/${h}.json`,
  session: (id: string, name: string) => `sessions/${id}/${name}`,
}

const REF_PREFIX = '{"$ref":"'
const enc = new TextEncoder()
const dec = new TextDecoder()

/** Per-isolate memory: decoded nodes, roots, schemas, bodies. Shared by every request. */
const isolateLru = new Lru<unknown>(32 * 1024 * 1024, (v) => {
  if (typeof v === 'string') return v.length * 2
  if (v && typeof v === 'object' && 'approxBytes' in v)
    return (v as { approxBytes: number }).approxBytes
  return 1024
})

export class Objects {
  constructor(
    readonly blobs: BlobStore,
    readonly cache: Cache,
    readonly lru: Lru<unknown> = isolateLru,
  ) {}

  /** An immutable object's bytes: shared cache, then the bucket. */
  async #immutable(key: string): Promise<Uint8Array | null> {
    const cached = await this.cache.get(key)
    if (cached) return cached
    const obj = await this.blobs.get(key)
    if (!obj) return null
    const bytes = await obj.bytes()
    await this.cache.put(key, bytes)
    return bytes
  }

  // --- Nodes ---

  async nodeJson(hash: string): Promise<string> {
    const key = keys.node(hash)
    const hit = this.lru.get(key)
    if (typeof hit === 'string') return hit
    const bytes = await this.#immutable(key)
    if (!bytes) throw new Error(`Missing node ${hash}`)
    const json = await gunzipText(bytes)
    this.lru.set(key, json)
    return json
  }

  async putNode(hash: string, json: string): Promise<void> {
    await this.blobs.put(keys.node(hash), await gzip(json), {
      contentType: 'application/gzip',
      ifAbsent: true,
    })
  }

  // --- Bodies ---

  /** A leaf's body lines, in entry order, with out-of-line records resolved. */
  async bodyLines(leafHash: string): Promise<string[]> {
    const key = keys.body(leafHash)
    const hit = this.lru.get(key)
    if (hit) return (hit as { lines: string[] }).lines
    const bytes = await this.#immutable(key)
    if (!bytes) throw new Error(`Missing body for leaf ${leafHash}`)
    let lines: string[]
    if (isGzip(bytes)) {
      lines = splitLines(await gunzipText(bytes))
    } else {
      const { parts } = JSON.parse(dec.decode(bytes)) as { parts: string[] }
      const texts = await Promise.all(
        parts.map(async (h) => {
          const b = await this.#immutable(keys.part(h))
          if (!b) throw new Error(`Missing body part ${h}`)
          return splitLines(await gunzipText(b))
        }),
      )
      lines = texts.flat()
    }
    if (lines.some((l) => l.startsWith(REF_PREFIX))) {
      lines = await Promise.all(
        lines.map((l) => (l.startsWith(REF_PREFIX) ? this.#outOfLine(l) : l)),
      )
    }
    const approxBytes = lines.reduce((n, l) => n + l.length * 2, 0)
    this.lru.set(key, { lines, approxBytes })
    return lines
  }

  async #outOfLine(pointer: string): Promise<string> {
    const hash = (JSON.parse(pointer) as { $ref: string }).$ref
    const b = await this.#immutable(keys.record(hash))
    if (!b) throw new Error(`Missing out-of-line record ${hash}`)
    return gunzipText(b)
  }

  async putBody(leafHash: string, lines: readonly string[]): Promise<void> {
    await this.blobs.put(keys.body(leafHash), await gzip(lines.join('\n') + '\n'), {
      contentType: 'application/gzip',
      ifAbsent: true,
    })
  }

  async putBodyParts(leafHash: string, parts: readonly string[]): Promise<void> {
    await this.blobs.put(keys.body(leafHash), JSON.stringify({ parts }), {
      contentType: 'application/json',
      ifAbsent: true,
    })
  }

  /** Write one body part; returns its hash (of the uncompressed text). */
  partOf(lines: readonly string[]): { hash: string; write: () => Promise<void> } {
    const text = lines.join('\n') + '\n'
    const hash = sha256Hex(text)
    return {
      hash,
      write: async () =>
        this.blobs.put(keys.part(hash), await gzip(text), {
          contentType: 'application/gzip',
          ifAbsent: true,
        }),
    }
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

  async root(hash: string): Promise<VersionRoot> {
    const key = keys.root(hash)
    const hit = this.lru.get(key)
    if (hit) return (hit as { root: VersionRoot }).root
    const bytes = await this.#immutable(key)
    if (!bytes) throw new Error(`Missing root ${hash}`)
    const text = dec.decode(bytes)
    const root = JSON.parse(text) as VersionRoot
    this.lru.set(key, { root, approxBytes: text.length * 3 })
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

  async privateSet(commitment: string): Promise<PrivateSetObject> {
    const key = keys.privateSet(commitment)
    const hit = this.lru.get(key)
    if (hit) return (hit as { set: PrivateSetObject }).set
    const bytes = await this.#immutable(key)
    if (!bytes) throw new Error(`Missing private set ${commitment}`)
    const text = dec.decode(bytes)
    const set = JSON.parse(text) as PrivateSetObject
    this.lru.set(key, { set, approxBytes: text.length * 3 })
    return set
  }

  async putPrivateSet(set: PrivateSetObject): Promise<string> {
    const commitment = privateCommitment(set)
    await this.blobs.put(keys.privateSet(commitment), jcs(set), {
      contentType: 'application/json',
      ifAbsent: true,
    })
    return commitment
  }

  async schema(hash: string): Promise<Record<string, unknown>> {
    const key = keys.schema(hash)
    const hit = this.lru.get(key)
    if (hit) return (hit as { schema: Record<string, unknown> }).schema
    const bytes = await this.#immutable(key)
    if (!bytes) throw new Error(`Missing schema ${hash}`)
    const text = dec.decode(bytes)
    const schema = JSON.parse(text) as Record<string, unknown>
    this.lru.set(key, { schema, approxBytes: text.length * 3 })
    return schema
  }

  async putSchema(schema: unknown): Promise<string> {
    const hash = hashSchema(schema)
    await this.blobs.put(keys.schema(hash), jcs(schema), {
      contentType: 'application/json',
      ifAbsent: true,
    })
    return hash
  }

  // --- Decoded nodes (for tree reads) ---

  async decoded<E>(spec: TreeSpec<E>, hash: string): Promise<DecodedNode<E>> {
    const key = `decoded:${spec.name}:${hash}`
    const hit = this.lru.get(key)
    if (hit) return (hit as { node: DecodedNode<E> }).node
    const json = await this.nodeJson(hash)
    const node = decodeNode(spec, json, hash)
    this.lru.set(key, { node, approxBytes: json.length * 3 })
    return node
  }
}

export const outOfLinePointer = (recordHash: string) => `${REF_PREFIX}${recordHash}"}`

/** NodeSource over the blob store. Record trees get bodies through `leafEntries`. */
export class BlobSource<E> implements NodeSource<E> {
  constructor(
    readonly spec: TreeSpec<E>,
    readonly objects: Objects,
  ) {}

  node(hash: string): Promise<DecodedNode<E>> {
    return this.objects.decoded(this.spec, hash)
  }

  async leafEntries(hash: string): Promise<E[]> {
    const node = await this.node(hash)
    if (node.kind !== 'leaf') throw new Error(`Node ${hash} is not a leaf`)
    if (this.spec !== (recordTree as TreeSpec<unknown>)) return node.entries.slice()
    const lines = await this.objects.bodyLines(hash)
    if (lines.length !== node.entries.length) {
      throw new Error(
        `Body of leaf ${hash} has ${lines.length} lines for ${node.entries.length} entries`,
      )
    }
    return (node.entries as RecordEntry[]).map((e, i) => ({ ...e, body: lines[i]! })) as E[]
  }
}

/**
 * TreeSink that writes nodes (and, for record trees, bodies) to the blob store.
 * The builder is synchronous; writes run in the background with bounded
 * concurrency. Call `drain()` between units of work to apply backpressure and
 * `flush()` before using the root.
 */
export class BlobSink<E> implements TreeSink<E> {
  readonly #pending = new Set<Promise<void>>()
  #error: unknown = null
  #parts: string[] = []
  written = 0

  constructor(
    readonly objects: Objects,
    readonly opts: { bodyOf?: (e: E) => string; concurrency?: number } = {},
  ) {}

  #run(work: () => Promise<void>) {
    const p = work()
      .catch((err) => {
        this.#error ??= err
      })
      .finally(() => this.#pending.delete(p))
    this.#pending.add(p)
    this.written++
  }

  spill(entries: readonly E[]): void {
    const { bodyOf } = this.opts
    if (!bodyOf) return
    const part = this.objects.partOf(entries.map(bodyOf))
    this.#parts.push(part.hash)
    this.#run(part.write)
  }

  leaf(desc: NodeDesc, json: string, entries: readonly E[], spilled: number): void {
    this.#run(() => this.objects.putNode(desc.hash, json))
    const { bodyOf } = this.opts
    if (!bodyOf) return
    if (this.#parts.length === 0) {
      const lines = entries.map(bodyOf)
      this.#run(() => this.objects.putBody(desc.hash, lines))
      return
    }
    const tail = entries.slice(spilled)
    if (tail.length > 0) {
      const part = this.objects.partOf(tail.map(bodyOf))
      this.#parts.push(part.hash)
      this.#run(part.write)
    }
    const parts = this.#parts
    this.#parts = []
    this.#run(() => this.objects.putBodyParts(desc.hash, parts))
  }

  interior(desc: NodeDesc, json: string): void {
    this.#run(() => this.objects.putNode(desc.hash, json))
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

/** Payload size for spilling: the body line's bytes. */
export const recordPayloadBytes = (e: RecordEntry) => e.body?.length ?? 0

/** Clear a record entry's body after it was written in a part. */
export const dropRecordBody = (e: RecordEntry) => {
  delete e.body
}

export const textBytes = (s: string) => enc.encode(s)
export { gunzip }
