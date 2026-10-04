import {
  type BlobHead,
  type BlobObject,
  joinParts,
  type Presigner,
  type PutOptions,
  type PutPartsOptions,
  type Store,
} from '../repo/types.js'

const enc = new TextEncoder()

export function blobObject(bytes: Uint8Array, head: Omit<BlobHead, 'size'>): BlobObject {
  return {
    ...head,
    size: bytes.byteLength,
    body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(),
    bytes: async () => bytes,
    text: async () => new TextDecoder().decode(bytes),
  }
}

/** An in-memory store, for tests and scratch work. Presigned URLs are `memory://` placeholders. */
export function memoryStore(): MemoryStore {
  return new MemoryStore()
}

export class MemoryStore implements Store {
  readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string | null; cacheControl?: string }
  >()
  readonly multipart = new Map<string, Map<number, Uint8Array>>()
  puts = 0
  gets = 0

  async get(key: string, range?: { offset: number; length?: number }) {
    this.gets++
    const o = this.objects.get(key)
    if (!o) return null
    const bytes = range
      ? o.bytes.subarray(
          range.offset,
          range.length === undefined ? undefined : range.offset + range.length,
        )
      : o.bytes
    return blobObject(bytes, { etag: `"${key}"`, contentType: o.contentType })
  }

  async head(key: string) {
    const o = this.objects.get(key)
    return o ? { size: o.bytes.byteLength, etag: `"${key}"`, contentType: o.contentType } : null
  }

  async put(key: string, body: Uint8Array | string, opts: PutOptions = {}) {
    if (opts.ifAbsent && this.objects.has(key)) return
    this.puts++
    this.objects.set(key, {
      bytes: typeof body === 'string' ? enc.encode(body) : body.slice(),
      contentType: opts.contentType ?? null,
      ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
    })
  }

  async putParts(key: string, parts: AsyncIterable<Uint8Array>, opts: PutPartsOptions = {}) {
    const bytes = await joinParts(parts)
    await opts.check?.()
    const { check: _, ...put } = opts
    await this.put(key, bytes, put)
  }

  async delete(key: string) {
    this.objects.delete(key)
  }

  async list(prefix: string, cursor?: string) {
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && (!cursor || k > cursor))
      .sort()
    const page = keys.slice(0, 1000)
    return page.length === 1000 ? { keys: page, cursor: page[page.length - 1]! } : { keys: page }
  }

  readonly presigner: Presigner = {
    presignGet: async (key) => `memory://get/${key}`,
    presignPut: async (key) => `memory://put/${key}`,
    createMultipart: async (key) => {
      const id = crypto.randomUUID()
      this.multipart.set(`${key}#${id}`, new Map())
      return id
    },
    presignPart: async (key, uploadId, partNumber) =>
      `memory://part/${key}?uploadId=${uploadId}&partNumber=${partNumber}`,
    completeMultipart: async (key, uploadId, parts) => {
      const stored = this.multipart.get(`${key}#${uploadId}`)
      if (!stored) throw new Error('No such upload')
      const chunks = parts.map((p) => stored.get(p.partNumber)!)
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let off = 0
      for (const c of chunks) {
        out.set(c, off)
        off += c.byteLength
      }
      this.objects.set(key, { bytes: out, contentType: null })
      this.multipart.delete(`${key}#${uploadId}`)
    },
    abortMultipart: async (key, uploadId) => {
      this.multipart.delete(`${key}#${uploadId}`)
    },
  }

  /** Test helper standing in for a client PUT to a presigned part URL. */
  uploadPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array): string {
    this.multipart.get(`${key}#${uploadId}`)!.set(partNumber, bytes)
    return `"part-${partNumber}"`
  }

  async copy(from: string, to: string) {
    const o = this.objects.get(from)
    if (!o) throw new Error(`No such key ${from}`)
    this.objects.set(to, { bytes: o.bytes.slice(), contentType: o.contentType })
  }
}
