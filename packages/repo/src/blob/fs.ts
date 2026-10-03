/**
 * Filesystem blob store for development and small self-hosted Node setups.
 *
 * Presigned URLs point at the app itself (`/_blob/<key>`), signed with HMAC; the
 * Node entry serves them through `serveSignedBlob`. Bytes still never pass
 * through the API routes, and the same client flow (presigned PUT, then GET by
 * redirect) works as on R2.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

import type {
  BlobHead,
  BlobObject,
  BlobStore,
  PresignGetOptions,
  PresignPutOptions,
  PutOptions,
} from '../types.js'

export interface FsBlobConfig {
  root: string
  /** Public base URL of the app, for presigned URLs. */
  publicUrl: string
  /** HMAC secret for presigned URLs. */
  secret: string
}

export class FsBlobStore implements BlobStore {
  readonly #root: string
  constructor(readonly cfg: FsBlobConfig) {
    this.#root = resolve(cfg.root)
  }

  #path(key: string): string {
    const p = resolve(this.#root, key)
    if (!p.startsWith(this.#root + sep)) throw new Error(`Bad blob key: ${key}`)
    return p
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null> {
    const path = this.#path(key)
    const st = await stat(path).catch(() => null)
    if (!st?.isFile()) return null
    const start = range?.offset ?? 0
    const end =
      range?.length === undefined ? st.size - 1 : Math.min(st.size - 1, start + range.length - 1)
    const size = Math.max(0, end - start + 1)
    const head = {
      size,
      etag: `"${st.mtimeMs}-${st.size}"`,
      contentType: await this.#contentType(key),
    }
    const read = async () => {
      if (size === 0) return new Uint8Array()
      const fh = await open(path)
      try {
        const buf = new Uint8Array(size)
        await fh.read(buf, 0, size, start)
        return buf
      } finally {
        await fh.close()
      }
    }
    return {
      ...head,
      get body() {
        return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
      },
      bytes: read,
      text: async () => new TextDecoder().decode(await read()),
    }
  }

  async #contentType(key: string): Promise<string | null> {
    return readFile(this.#path(key) + '.__type', 'utf8').catch(() => null)
  }

  async head(key: string): Promise<BlobHead | null> {
    const st = await stat(this.#path(key)).catch(() => null)
    if (!st?.isFile()) return null
    return {
      size: st.size,
      etag: `"${st.mtimeMs}-${st.size}"`,
      contentType: await this.#contentType(key),
    }
  }

  async put(key: string, body: Uint8Array | string, opts: PutOptions = {}): Promise<void> {
    const path = this.#path(key)
    if (opts.ifAbsent && (await stat(path).catch(() => null))) return
    await mkdir(dirname(path), { recursive: true })
    // Write then rename, so a reader never sees a partial object.
    const tmp = `${path}.${crypto.randomUUID()}.tmp`
    await writeFile(tmp, body)
    await rename(tmp, path)
    if (opts.contentType) await writeFile(path + '.__type', opts.contentType)
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true })
    await rm(this.#path(key) + '.__type', { force: true })
  }

  async list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }> {
    const out: string[] = []
    const walk = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (!e.name.endsWith('.__type') && !e.name.endsWith('.tmp')) {
          const key = relative(this.#root, p).split(sep).join('/')
          if (key.startsWith(prefix) && (!cursor || key > cursor)) out.push(key)
        }
      }
    }
    await walk(this.#root)
    out.sort()
    const page = out.slice(0, 1000)
    return page.length === 1000 ? { keys: page, cursor: page[page.length - 1]! } : { keys: page }
  }

  sign(method: string, key: string, exp: number, extra = ''): string {
    return createHmac('sha256', this.cfg.secret)
      .update(`${method}\n${key}\n${exp}\n${extra}`)
      .digest('hex')
  }

  #signedUrl(method: string, key: string, expiresIn: number, params: Record<string, string> = {}) {
    const exp = Math.floor(Date.now() / 1000) + expiresIn
    const extra = new URLSearchParams(params).toString()
    const u = new URL(
      `${this.cfg.publicUrl.replace(/\/$/, '')}/_blob/${key.split('/').map(encodeURIComponent).join('/')}`,
    )
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    u.searchParams.set('m', method)
    u.searchParams.set('exp', String(exp))
    u.searchParams.set('sig', this.sign(method, key, exp, extra))
    return u.toString()
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    const params: Record<string, string> = {}
    if (opts.disposition) params.disposition = opts.disposition
    if (opts.contentType) params.type = opts.contentType
    return this.#signedUrl('GET', key, opts.expiresIn, params)
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    return this.#signedUrl('PUT', key, opts.expiresIn)
  }

  async createMultipart(key: string): Promise<string> {
    const id = crypto.randomUUID()
    await mkdir(this.#path(`_multipart/${id}`), { recursive: true })
    await writeFile(this.#path(`_multipart/${id}/.key`), key)
    return id
  }

  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return this.#signedUrl('PUT', `_multipart/${uploadId}/${partNumber}`, expiresIn)
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const path = this.#path(key)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${crypto.randomUUID()}.tmp`
    const fh = await open(tmp, 'w')
    try {
      for (const p of parts)
        await fh.write(await readFile(this.#path(`_multipart/${uploadId}/${p.partNumber}`)))
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
    await rm(this.#path(`_multipart/${uploadId}`), { recursive: true, force: true })
  }

  async copy(from: string, to: string): Promise<void> {
    const src = this.#path(from)
    const dest = this.#path(to)
    await mkdir(dirname(dest), { recursive: true })
    const tmp = `${dest}.${crypto.randomUUID()}.tmp`
    await copyFile(src, tmp)
    await rename(tmp, dest)
  }

  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    await rm(this.#path(`_multipart/${uploadId}`), { recursive: true, force: true })
  }

  /** Verify a presigned `/_blob/…` request. Returns the key, or null if the signature is bad or expired. */
  verify(method: string, url: URL): string | null {
    const key = decodeURIComponent(url.pathname.replace(/^\/_blob\//, ''))
    const exp = Number(url.searchParams.get('exp'))
    const sig = url.searchParams.get('sig') ?? ''
    if (url.searchParams.get('m') !== method || !Number.isFinite(exp) || exp < Date.now() / 1000)
      return null
    const params: Record<string, string> = {}
    for (const p of ['disposition', 'type']) {
      const v = url.searchParams.get(p)
      if (v !== null) params[p] = v
    }
    const want = this.sign(method, key, exp, new URLSearchParams(params).toString())
    const a = Buffer.from(sig, 'hex')
    const b = Buffer.from(want, 'hex')
    return a.length === b.length && timingSafeEqual(a, b) ? key : null
  }
}

/** Serve a presigned `/_blob/…` GET or PUT for an FsBlobStore (Node entry only). */
export async function serveSignedBlob(store: FsBlobStore, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const key = store.verify(req.method, url)
  if (!key) return new Response('Forbidden', { status: 403 })
  if (req.method === 'PUT') {
    await store.put(key, new Uint8Array(await req.arrayBuffer()))
    return new Response(null, { status: 200, headers: { etag: `"${key.split('/').pop()}"` } })
  }
  const obj = await store.get(key)
  if (!obj) return new Response('Not found', { status: 404 })
  const headers: Record<string, string> = { 'content-length': String(obj.size) }
  const type = url.searchParams.get('type') ?? obj.contentType
  if (type) headers['content-type'] = type
  const disposition = url.searchParams.get('disposition')
  if (disposition) headers['content-disposition'] = disposition
  return new Response(obj.body, { headers })
}
