/** The storage interfaces a repository is read and written through. */

export interface BlobHead {
  size: number
  etag: string
  contentType: string | null
}

export interface BlobObject extends BlobHead {
  body: ReadableStream<Uint8Array>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
}

export interface PutOptions {
  contentType?: string
  /** Only write if the key doesn't exist. Immutable keys make this an optimization. */
  ifAbsent?: boolean
}

export interface PutPartsOptions extends PutOptions {
  /** Runs after the last part and before the object appears; throwing abandons the write. */
  check?: () => void | Promise<void>
}

export interface PresignGetOptions {
  expiresIn: number
  /** Content-Disposition for the response. */
  disposition?: string
  contentType?: string
}

export interface PresignPutOptions {
  expiresIn: number
  contentType?: string
}

/**
 * Where a repository's objects live: an S3-like bucket. The five methods are
 * what reading, writing, mirroring and restore need, and every store has them.
 * Stores: `memoryStore()`, `fileStore(dir)`, `s3Store({…})`, `r2Store(binding)`.
 *
 * `list` cursors are opaque: pass back exactly what the previous page returned.
 */
export interface Store {
  /** The object, or a byte range of it (`size` is then the range's size); null if absent. */
  get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null>
  head(key: string): Promise<BlobHead | null>
  /** `ifAbsent` on an existing key succeeds without writing (keys are immutable). */
  put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void>
  /** Keys under a prefix in byte order, a page at a time. */
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>
  /** Deleting an absent key succeeds. */
  delete(key: string): Promise<void>
  /**
   * Write an object from parts, in order, without holding it whole: a multipart
   * upload where the store has one. Every part but the last must be at least
   * 5 MiB (S3's minimum). `putFromParts` falls back to put for stores without it.
   */
  putParts?(key: string, parts: AsyncIterable<Uint8Array>, opts?: PutPartsOptions): Promise<void>
  /**
   * Server-side copy, where the store has one; `copyObject` falls back to get and
   * put. Given the size, a store may copy a large object in parts (S3: over 5 GiB).
   */
  copy?(from: string, to: string, size?: number): Promise<void>
  /** Presigned URLs and multipart uploads, where the store can hand out URLs. */
  readonly presigner?: Presigner
}

/** Direct client access to a store: what the platform needs for uploads and downloads. */
export interface Presigner {
  presignGet(key: string, opts: PresignGetOptions): Promise<string>
  presignPut(key: string, opts: PresignPutOptions): Promise<string>
  createMultipart(key: string, contentType?: string): Promise<string>
  presignPart(key: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string>
  completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>
  abortMultipart(key: string, uploadId: string): Promise<void>
}

/** A store that can presign. */
export type PresigningStore = Store & { readonly presigner: Presigner }

/** Copy an object within a store: natively when it can, else by reading and writing it. */
export async function copyObject(
  store: Store,
  from: string,
  to: string,
  size?: number,
): Promise<void> {
  if (store.copy) return store.copy(from, to, size)
  const obj = await store.get(from)
  if (!obj) throw new Error(`copyObject: ${from} does not exist`)
  await store.put(to, await obj.bytes(), obj.contentType ? { contentType: obj.contentType } : {})
}

/** An object read as consecutive byte ranges of `partBytes`. */
export async function* readParts(
  store: Store,
  key: string,
  size: number,
  partBytes: number,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < size; offset += partBytes) {
    const obj = await store.get(key, { offset, length: Math.min(partBytes, size - offset) })
    if (!obj) throw new Error(`${key} is missing`)
    yield await obj.bytes()
  }
}

/** Write from parts with the store's putParts, or by joining them and putting. */
export async function putFromParts(
  store: Store,
  key: string,
  parts: AsyncIterable<Uint8Array>,
  opts: PutPartsOptions = {},
): Promise<void> {
  if (store.putParts) return store.putParts(key, parts, opts)
  const bytes = await joinParts(parts)
  await opts.check?.()
  const { check: _, ...put } = opts
  await store.put(key, bytes, put)
}

/** S3's (and R2's) smallest part, except the last. */
export const MIN_PART_BYTES = 5 * 1024 * 1024

/** A started multipart upload, as `writeInParts` drives it. */
export interface MultipartWriter {
  part(partNumber: number, bytes: Uint8Array): Promise<{ partNumber: number; etag: string }>
  complete(parts: { partNumber: number; etag: string }[]): Promise<void>
  abort(): Promise<void>
}

/**
 * A multipart write from parts of any size: small ones are joined up to
 * MIN_PART_BYTES, and an object that fits in one part is a plain `single` put.
 * `check` runs before the object appears; a failure aborts the upload.
 */
export async function writeInParts(
  parts: AsyncIterable<Uint8Array>,
  check: (() => void | Promise<void>) | undefined,
  w: { single(bytes: Uint8Array): Promise<void>; begin(): Promise<MultipartWriter> },
): Promise<void> {
  const it = joinUpTo(parts, MIN_PART_BYTES)[Symbol.asyncIterator]()
  let cur = await it.next()
  let next = cur.done ? cur : await it.next()
  if (next.done) {
    await check?.()
    return w.single(cur.done ? new Uint8Array(0) : cur.value)
  }
  const upload = await w.begin()
  try {
    const done: { partNumber: number; etag: string }[] = []
    while (!cur.done) {
      done.push(await upload.part(done.length + 1, cur.value))
      cur = next
      next = cur.done ? cur : await it.next()
    }
    await check?.()
    await upload.complete(done)
  } catch (err) {
    await upload.abort().catch(() => {})
    throw err
  }
}

/** Parts of at least `min` bytes (the last may be smaller), joining small ones. */
async function* joinUpTo(
  parts: AsyncIterable<Uint8Array>,
  min: number,
): AsyncGenerator<Uint8Array> {
  let held: Uint8Array[] = []
  let n = 0
  for await (const p of parts) {
    held.push(p)
    n += p.byteLength
    if (n >= min) {
      yield held.length === 1 ? held[0]! : await joinParts(held)
      held = []
      n = 0
    }
  }
  if (held.length > 0) yield held.length === 1 ? held[0]! : await joinParts(held)
}

/** Concatenate parts (stores with no multipart write). */
export async function joinParts(
  parts: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const p of parts) chunks.push(p)
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** Every key under a prefix, following list pages. */
export async function* listAll(store: Store, prefix: string): AsyncGenerator<string> {
  let cursor: string | undefined
  do {
    const page = await store.list(prefix, cursor)
    yield* page.keys
    cursor = page.cursor
  } while (cursor !== undefined)
}

/** A shared cache for immutable, hash-keyed bytes (nodes, roots, schemas, bodies). */
export interface Cache {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array, opts?: { ttlSeconds?: number }): Promise<void>
}

/** A cache that holds nothing (tests that count blob reads; untrusted locations). */
export const noCache: Cache = {
  get: async () => null,
  put: async () => {},
}

/**
 * A store whose keys live under a prefix: one location's repository inside a
 * bucket shared with other things. `prefix` has no trailing slash ('' for none).
 * List cursors pass through untouched, since they're opaque to everyone but the
 * inner store.
 */
export class PrefixedStore implements Store {
  readonly #p: string
  readonly presigner?: Presigner
  readonly copy?: (from: string, to: string, size?: number) => Promise<void>
  readonly putParts?: (
    key: string,
    parts: AsyncIterable<Uint8Array>,
    opts?: PutPartsOptions,
  ) => Promise<void>
  constructor(
    readonly inner: Store,
    prefix: string,
  ) {
    const p = prefix ? `${prefix.replace(/\/+$/, '')}/` : ''
    this.#p = p
    const k = (key: string) => p + key
    const inn = inner.presigner
    if (inn) {
      this.presigner = {
        presignGet: (key, opts) => inn.presignGet(k(key), opts),
        presignPut: (key, opts) => inn.presignPut(k(key), opts),
        createMultipart: (key, type) => inn.createMultipart(k(key), type),
        presignPart: (key, id, n, exp) => inn.presignPart(k(key), id, n, exp),
        completeMultipart: (key, id, parts) => inn.completeMultipart(k(key), id, parts),
        abortMultipart: (key, id) => inn.abortMultipart(k(key), id),
      }
    }
    if (inner.copy) {
      const copy = inner.copy.bind(inner)
      this.copy = (from, to, size) => copy(k(from), k(to), size)
    }
    if (inner.putParts) {
      const putParts = inner.putParts.bind(inner)
      this.putParts = (key, parts, opts) => putParts(k(key), parts, opts)
    }
  }
  #k = (key: string) => this.#p + key
  get(key: string, range?: { offset: number; length?: number }) {
    return this.inner.get(this.#k(key), range)
  }
  head(key: string) {
    return this.inner.head(this.#k(key))
  }
  put(key: string, body: Uint8Array | string, opts?: PutOptions) {
    return this.inner.put(this.#k(key), body, opts)
  }
  delete(key: string) {
    return this.inner.delete(this.#k(key))
  }
  async list(prefix: string, cursor?: string) {
    const r = await this.inner.list(this.#k(prefix), cursor)
    const keys = r.keys.map((k) => k.slice(this.#p.length))
    return r.cursor === undefined ? { keys } : { keys, cursor: r.cursor }
  }
}
