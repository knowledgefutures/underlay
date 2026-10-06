/**
 * A store in a local directory: the CLI's offline `.underlay/`, development, and
 * small self-hosted Node setups.
 *
 * Given a public URL and a secret, it also presigns: URLs point at the app
 * itself (`/_blob/<key>`), signed with HMAC, and the Node entry serves them
 * through `serveSignedBlob`. Bytes still never pass through the API routes, and
 * the same client flow (presigned PUT, then GET by redirect) works as on R2.
 *
 * Node's modules are fetched on first use with `process.getBuiltinModule`, so
 * importing the package never pulls in `node:fs` (browsers, Workers), and no
 * bundler trips over a `node:` import.
 */
import type * as NodeFs from 'node:fs'
import type * as NodeFsp from 'node:fs/promises'
import type * as NodePath from 'node:path'
import type * as NodeStream from 'node:stream'

import type {
  BlobHead,
  BlobObject,
  ListPage,
  PresignGetOptions,
  Presigner,
  PresigningStore,
  PresignPutOptions,
  PutOptions,
  PutPartsOptions,
  Store,
} from '../repo/types.js'

export interface FileStoreOptions {
  /** Public base URL of the app, for presigned URLs. */
  publicUrl: string
  /** HMAC secret for presigned URLs. */
  secret: string
}

interface NodeModules {
  fs: typeof NodeFs
  fsp: typeof NodeFsp
  path: typeof NodePath
  stream: typeof NodeStream
}
type GetBuiltin = (id: string) => unknown
let nodeModules: NodeModules | undefined
/** Node's modules, through `process.getBuiltinModule` so no bundler sees a `node:` import. */
const node = async (): Promise<NodeModules> => {
  if (nodeModules) return nodeModules
  const get = (globalThis as { process?: { getBuiltinModule?: GetBuiltin } }).process
    ?.getBuiltinModule
  if (!get) throw new Error('fileStore needs Node (process.getBuiltinModule, Node ≥ 22.3)')
  return (nodeModules = {
    fs: get('node:fs') as typeof NodeFs,
    fsp: get('node:fs/promises') as typeof NodeFsp,
    path: get('node:path') as typeof NodePath,
    stream: get('node:stream') as typeof NodeStream,
  })
}

const enc = new TextEncoder()
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)))

/** A store in a directory; with `presign`, one that presigns URLs served by the app. */
export function fileStore(root: string): FileStore
export function fileStore(root: string, presign: FileStoreOptions): FileStore & PresigningStore
export function fileStore(root: string, presign?: FileStoreOptions): FileStore {
  return new FileStore(root, presign)
}

export class FileStore implements Store {
  #key: Promise<CryptoKey> | undefined
  readonly presigner?: Presigner
  constructor(
    readonly root: string,
    readonly signing?: FileStoreOptions,
  ) {
    if (signing) {
      this.presigner = {
        presignGet: (key, opts) => this.#presignGet(key, opts),
        presignPut: (key, opts) => this.#presignPut(key, opts),
        createMultipart: (key) => this.#createMultipart(key),
        presignPart: (key, id, n, exp) => this.#presignPart(key, id, n, exp),
        completeMultipart: (key, id, parts) => this.#completeMultipart(key, id, parts),
        abortMultipart: (key, id) => this.#abortMultipart(key, id),
      }
    }
  }

  /** Node modules plus the absolute path of a key (which must stay under the root). */
  async #at(key: string) {
    const m = await node()
    const root = m.path.resolve(this.root)
    const p = m.path.resolve(root, key)
    if (!p.startsWith(root + m.path.sep)) throw new Error(`Bad blob key: ${key}`)
    return { ...m, root, p }
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null> {
    const { fs, fsp, stream, p: path } = await this.#at(key)
    const st = await fsp.stat(path).catch(() => null)
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
      const fh = await fsp.open(path)
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
        return stream.Readable.toWeb(
          fs.createReadStream(path, { start, end }),
        ) as ReadableStream<Uint8Array>
      },
      bytes: read,
      text: async () => new TextDecoder().decode(await read()),
    }
  }

  async #contentType(key: string): Promise<string | null> {
    const { fsp, p } = await this.#at(key)
    return fsp.readFile(p + '.__type', 'utf8').catch(() => null)
  }

  async head(key: string): Promise<BlobHead | null> {
    const { fsp, p } = await this.#at(key)
    const st = await fsp.stat(p).catch(() => null)
    if (!st?.isFile()) return null
    return {
      size: st.size,
      etag: `"${st.mtimeMs}-${st.size}"`,
      contentType: await this.#contentType(key),
    }
  }

  async put(key: string, body: Uint8Array | string, opts: PutOptions = {}): Promise<void> {
    const { fsp, path: P, p: path } = await this.#at(key)
    if (opts.ifAbsent && (await fsp.stat(path).catch(() => null))) return
    await fsp.mkdir(P.dirname(path), { recursive: true })
    // Write then rename, so a reader never sees a partial object.
    const tmp = `${path}.${crypto.randomUUID()}.tmp`
    await fsp.writeFile(tmp, body)
    await fsp.rename(tmp, path)
    if (opts.contentType) await fsp.writeFile(path + '.__type', opts.contentType)
  }

  async putParts(
    key: string,
    parts: AsyncIterable<Uint8Array>,
    opts: PutPartsOptions = {},
  ): Promise<void> {
    const { fsp, path: P, p: path } = await this.#at(key)
    if (opts.ifAbsent && (await fsp.stat(path).catch(() => null))) return
    await fsp.mkdir(P.dirname(path), { recursive: true })
    // Appended part by part to a temporary file, renamed only once checked.
    const tmp = `${path}.${crypto.randomUUID()}.tmp`
    try {
      await fsp.writeFile(tmp, new Uint8Array(0))
      for await (const part of parts) await fsp.appendFile(tmp, part)
      await opts.check?.()
      await fsp.rename(tmp, path)
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
    if (opts.contentType) await fsp.writeFile(path + '.__type', opts.contentType)
  }

  async delete(key: string): Promise<void> {
    const { fsp, p } = await this.#at(key)
    await fsp.rm(p, { force: true })
    await fsp.rm(p + '.__type', { force: true })
  }

  async list(prefix: string, cursor?: string): Promise<ListPage> {
    const { fsp, path: P } = await node()
    const root = P.resolve(this.root)
    const out: string[] = []
    const walk = async (dir: string) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        const p = P.join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (!e.name.endsWith('.__type') && !e.name.endsWith('.tmp')) {
          const key = P.relative(root, p).split(P.sep).join('/')
          if (key.startsWith(prefix) && (!cursor || key > cursor)) out.push(key)
        }
      }
    }
    await walk(root)
    out.sort()
    const page = out.slice(0, 1000)
    const info = await Promise.all(
      page.map(async (k) => {
        const st = await fsp.stat(P.join(root, ...k.split('/'))).catch(() => null)
        return { size: st?.size ?? 0, modified: st?.mtimeMs ?? 0 }
      }),
    )
    return page.length === 1000
      ? { keys: page, cursor: page[page.length - 1]!, info }
      : { keys: page, info }
  }

  #signing(): FileStoreOptions {
    if (!this.signing) throw new Error('This file store was opened without presigning')
    return this.signing
  }

  #hmacKey(): Promise<CryptoKey> {
    return (this.#key ??= crypto.subtle.importKey(
      'raw',
      enc.encode(this.#signing().secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    ))
  }

  async sign(method: string, key: string, exp: number, extra = ''): Promise<string> {
    const msg = enc.encode(`${method}\n${key}\n${exp}\n${extra}`)
    return hex(await crypto.subtle.sign('HMAC', await this.#hmacKey(), msg))
  }

  async #signedUrl(
    method: string,
    key: string,
    expiresIn: number,
    params: Record<string, string> = {},
  ) {
    const exp = Math.floor(Date.now() / 1000) + expiresIn
    const extra = new URLSearchParams(params).toString()
    const u = new URL(
      `${this.#signing().publicUrl.replace(/\/$/, '')}/_blob/${key.split('/').map(encodeURIComponent).join('/')}`,
    )
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    u.searchParams.set('m', method)
    u.searchParams.set('exp', String(exp))
    u.searchParams.set('sig', await this.sign(method, key, exp, extra))
    return u.toString()
  }

  async #presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    const params: Record<string, string> = {}
    if (opts.disposition) params.disposition = opts.disposition
    if (opts.contentType) params.type = opts.contentType
    return this.#signedUrl('GET', key, opts.expiresIn, params)
  }

  async #presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    return this.#signedUrl('PUT', key, opts.expiresIn)
  }

  async #createMultipart(key: string): Promise<string> {
    const id = crypto.randomUUID()
    const { fsp, p } = await this.#at(`_multipart/${id}`)
    await fsp.mkdir(p, { recursive: true })
    await fsp.writeFile(`${p}/.key`, key)
    return id
  }

  async #presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return this.#signedUrl('PUT', `_multipart/${uploadId}/${partNumber}`, expiresIn)
  }

  async #completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const { fsp, path: P, p: path } = await this.#at(key)
    const dir = (await this.#at(`_multipart/${uploadId}`)).p
    await fsp.mkdir(P.dirname(path), { recursive: true })
    const tmp = `${path}.${crypto.randomUUID()}.tmp`
    const fh = await fsp.open(tmp, 'w')
    try {
      for (const p of parts) await fh.write(await fsp.readFile(`${dir}/${p.partNumber}`))
    } finally {
      await fh.close()
    }
    await fsp.rename(tmp, path)
    await fsp.rm(dir, { recursive: true, force: true })
  }

  async copy(from: string, to: string): Promise<void> {
    const src = (await this.#at(from)).p
    const { fsp, path: P, p: dest } = await this.#at(to)
    await fsp.mkdir(P.dirname(dest), { recursive: true })
    const tmp = `${dest}.${crypto.randomUUID()}.tmp`
    await fsp.copyFile(src, tmp)
    await fsp.rename(tmp, dest)
  }

  async #abortMultipart(_key: string, uploadId: string): Promise<void> {
    const { fsp, p } = await this.#at(`_multipart/${uploadId}`)
    await fsp.rm(p, { recursive: true, force: true })
  }

  /** Verify a presigned `/_blob/…` request. Returns the key, or null if the signature is bad or expired. */
  async verify(method: string, url: URL): Promise<string | null> {
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
    const msg = enc.encode(`${method}\n${key}\n${exp}\n${new URLSearchParams(params).toString()}`)
    // Constant-time comparison is subtle.verify's job.
    const ok = await crypto.subtle.verify('HMAC', await this.#hmacKey(), unhex(sig), msg)
    return ok ? key : null
  }
}

/** Serve a presigned `/_blob/…` GET or PUT for a presigning file store (Node entry only). */
export async function serveSignedBlob(store: FileStore, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const key = await store.verify(req.method, url)
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
