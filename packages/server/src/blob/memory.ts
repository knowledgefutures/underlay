import type { BlobHead, BlobObject, BlobStore, PutOptions } from '../ports.js'

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

/** In-memory blob store for tests. Presigned URLs are `memory://` placeholders. */
export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string | null }>()
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
    })
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

  async presignGet(key: string) {
    return `memory://get/${key}`
  }

  async presignPut(key: string) {
    return `memory://put/${key}`
  }

  async createMultipart(key: string) {
    const id = crypto.randomUUID()
    this.multipart.set(`${key}#${id}`, new Map())
    return id
  }

  async presignPart(key: string, uploadId: string, partNumber: number) {
    return `memory://part/${key}?uploadId=${uploadId}&partNumber=${partNumber}`
  }

  /** Test helper standing in for a client PUT to a presigned part URL. */
  uploadPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array): string {
    this.multipart.get(`${key}#${uploadId}`)!.set(partNumber, bytes)
    return `"part-${partNumber}"`
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const stored = this.multipart.get(`${key}#${uploadId}`)
    if (!stored) throw new Error('No such upload')
    const chunks = parts.map((p) => stored.get(p.partNumber)!)
    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.byteLength
    }
    this.objects.set(key, { bytes: out, contentType: null })
    this.multipart.delete(`${key}#${uploadId}`)
  }

  async abortMultipart(key: string, uploadId: string) {
    this.multipart.delete(`${key}#${uploadId}`)
  }
}
