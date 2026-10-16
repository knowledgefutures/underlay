/**
 * A store over a Workers R2 binding: the platform primary on Workers, and
 * Miniflare in tests. The binding can't presign or copy, so the platform keeps
 * an `s3Store` on the same bucket for presigned file URLs, and `copyObject`
 * reads and writes.
 *
 * The binding's types are declared structurally here, so the package needs no
 * Workers type definitions.
 */
import {
  type BlobHead,
  type BlobObject,
  joinParts,
  type ListPage,
  type PutOptions,
  type PutPartsOptions,
  type Store,
  writeInParts,
} from '../repo/types.js'

interface R2ObjectLike {
  size: number
  httpEtag: string
  httpMetadata?: { contentType?: string }
}

interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

/** The parts of an R2 bucket binding this store uses. */
export interface R2BucketLike {
  get(
    key: string,
    options?: { range?: { offset: number; length?: number } },
  ): Promise<R2ObjectBodyLike | null>
  head(key: string): Promise<R2ObjectLike | null>
  put(
    key: string,
    value: Uint8Array | string | ReadableStream<Uint8Array>,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string }
      onlyIf?: Headers
    },
  ): Promise<R2ObjectLike | null>
  delete(key: string): Promise<void>
  /** Multipart uploads (Workers bindings have them; a stand-in may not). */
  createMultipartUpload?(
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{
    uploadPart(partNumber: number, value: Uint8Array): Promise<{ partNumber: number; etag: string }>
    complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>
    abort(): Promise<void>
  }>
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; size?: number; uploaded?: Date }[]
    truncated: boolean
    cursor?: string
  }>
}

/**
 * Workers' FixedLengthStream: a stream the R2 binding can take as a put body,
 * since it knows its length. Absent outside workerd (Node, Miniflare's proxy).
 */
type FixedLengthStreamCtor = new (length: number) => TransformStream<Uint8Array, Uint8Array>
const FixedLengthStream = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor })
  .FixedLengthStream

/** A store over an R2 binding. */
export function r2Store(bucket: R2BucketLike): Store {
  return new R2Store(bucket)
}

const headOf = (o: R2ObjectLike): BlobHead => ({
  size: o.size,
  etag: o.httpEtag,
  contentType: o.httpMetadata?.contentType ?? null,
})

class R2Store implements Store {
  readonly putPieces?: (key: string, pieces: readonly Uint8Array[], opts?: PutOptions) => Promise<void>

  constructor(readonly bucket: R2BucketLike) {
    if (FixedLengthStream) {
      const Fixed = FixedLengthStream
      this.putPieces = (key, pieces, opts) => this.#putStream(Fixed, key, pieces, opts)
    }
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null> {
    if (range) {
      const obj = await this.bucket.get(key, { range })
      if (!obj) return null
      // `size` is the whole object's; the contract wants the range's.
      const rest = Math.max(0, obj.size - range.offset)
      return this.#object(obj, Math.min(range.length ?? rest, rest))
    }
    const obj = await this.bucket.get(key)
    return obj ? this.#object(obj, obj.size) : null
  }

  #object(obj: R2ObjectBodyLike, size: number): BlobObject {
    return {
      ...headOf(obj),
      size,
      get body() {
        return obj.body
      },
      bytes: async () => new Uint8Array(await obj.arrayBuffer()),
      text: () => obj.text(),
    }
  }

  async head(key: string): Promise<BlobHead | null> {
    const o = await this.bucket.head(key)
    return o ? headOf(o) : null
  }

  async put(key: string, body: Uint8Array | string, opts: PutOptions = {}): Promise<void> {
    await this.#put(key, body, opts)
  }

  #put(key: string, body: Uint8Array | string | ReadableStream<Uint8Array>, opts: PutOptions) {
    // A failed `If-None-Match: *` precondition returns null: the key exists, which
    // for immutable keys is success.
    const httpMetadata = {
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
      ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
    }
    return this.bucket.put(key, body, {
      ...(Object.keys(httpMetadata).length ? { httpMetadata } : {}),
      ...(opts.ifAbsent ? { onlyIf: new Headers({ 'if-none-match': '*' }) } : {}),
    })
  }

  /**
   * The pieces written one after another into a stream of their total length,
   * so the binding never gets (and copies) one joined buffer.
   */
  async #putStream(
    Fixed: FixedLengthStreamCtor,
    key: string,
    pieces: readonly Uint8Array[],
    opts: PutOptions = {},
  ): Promise<void> {
    const { readable, writable } = new Fixed(pieces.reduce((n, p) => n + p.byteLength, 0))
    const writer = writable.getWriter()
    const put = this.#put(key, readable, opts)
    const written = (async () => {
      for (const p of pieces) await writer.write(p)
      await writer.close()
    })()
    let stored
    try {
      stored = await put
    } catch (err) {
      // Unblocks a write waiting on a reader that is gone.
      await writer.abort(err).catch(() => {})
      await written.catch(() => {})
      throw err
    }
    if (stored === null) {
      // The key exists (ifAbsent): the body may never be read, so stop writing it.
      await writer.abort().catch(() => {})
      await written.catch(() => {})
      return
    }
    await written
  }

  async putParts(
    key: string,
    parts: AsyncIterable<Uint8Array>,
    opts: PutPartsOptions = {},
  ): Promise<void> {
    const { check, ...put } = opts
    const multipart = this.bucket.createMultipartUpload?.bind(this.bucket)
    if (!multipart) {
      const bytes = await joinParts(parts)
      await check?.()
      return this.put(key, bytes, put)
    }
    if (opts.ifAbsent && (await this.bucket.head(key))) return
    await writeInParts(parts, check, {
      single: (bytes) => this.put(key, bytes, put),
      begin: async () => {
        const upload = await multipart(
          key,
          opts.contentType ? { httpMetadata: { contentType: opts.contentType } } : {},
        )
        return {
          part: (n, bytes) => upload.uploadPart(n, bytes),
          complete: async (done) => void (await upload.complete(done)),
          abort: () => upload.abort(),
        }
      },
    })
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key)
  }

  async list(prefix: string, cursor?: string): Promise<ListPage> {
    const r = await this.bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) })
    const keys = r.objects.map((o) => o.key)
    const info = r.objects.map((o) => ({ size: o.size ?? 0, modified: o.uploaded?.getTime() ?? 0 }))
    return r.truncated && r.cursor ? { keys, cursor: r.cursor, info } : { keys, info }
  }
}
