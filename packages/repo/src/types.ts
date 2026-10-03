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

/** An S3-like bucket. Adapters: S3 API (R2, S3, MinIO), filesystem, memory. */
export interface BlobStore {
  get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null>
  head(key: string): Promise<BlobHead | null>
  put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>
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
 * A BlobStore whose keys live under a prefix: one location's repository inside a
 * bucket shared with other things. `prefix` has no trailing slash ('' for none).
 */
export class PrefixedBlobStore implements BlobStore {
  readonly #p: string
  constructor(
    readonly inner: BlobStore,
    prefix: string,
  ) {
    this.#p = prefix ? `${prefix.replace(/\/+$/, '')}/` : ''
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
    const r = await this.inner.list(
      this.#k(prefix),
      cursor === undefined ? undefined : this.#k(cursor),
    )
    const keys = r.keys.map((k) => k.slice(this.#p.length))
    return r.cursor === undefined ? { keys } : { keys, cursor: r.cursor.slice(this.#p.length) }
  }
  presignGet(key: string, opts: PresignGetOptions) {
    return this.inner.presignGet(this.#k(key), opts)
  }
  presignPut(key: string, opts: PresignPutOptions) {
    return this.inner.presignPut(this.#k(key), opts)
  }
  createMultipart(key: string, contentType?: string) {
    return this.inner.createMultipart(this.#k(key), contentType)
  }
  presignPart(key: string, uploadId: string, partNumber: number, expiresIn: number) {
    return this.inner.presignPart(this.#k(key), uploadId, partNumber, expiresIn)
  }
  completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    return this.inner.completeMultipart(this.#k(key), uploadId, parts)
  }
  abortMultipart(key: string, uploadId: string) {
    return this.inner.abortMultipart(this.#k(key), uploadId)
  }
}
