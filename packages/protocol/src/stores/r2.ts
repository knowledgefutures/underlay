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
    value: Uint8Array | string,
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
  list(options: {
    prefix?: string
    cursor?: string
    limit?: number
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>
}

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
  constructor(readonly bucket: R2BucketLike) {}

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
    // A failed `If-None-Match: *` precondition returns null: the key exists, which
    // for immutable keys is success.
    const httpMetadata = {
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
      ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
    }
    await this.bucket.put(key, body, {
      ...(Object.keys(httpMetadata).length ? { httpMetadata } : {}),
      ...(opts.ifAbsent ? { onlyIf: new Headers({ 'if-none-match': '*' }) } : {}),
    })
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

  async list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }> {
    const r = await this.bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) })
    const keys = r.objects.map((o) => o.key)
    return r.truncated && r.cursor ? { keys, cursor: r.cursor } : { keys }
  }
}
