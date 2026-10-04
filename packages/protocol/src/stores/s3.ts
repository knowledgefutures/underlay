/**
 * A store over the S3 API, signed with aws4fetch. Works against R2, S3 and
 * MinIO, from Workers and Node alike, and can presign (which the R2 binding
 * can't). Path-style URLs: `${endpoint}/${bucket}/${key}`.
 */
import { AwsClient } from 'aws4fetch'

import type {
  BlobHead,
  BlobObject,
  PresignGetOptions,
  Presigner,
  PresignPutOptions,
  PutOptions,
  PutPartsOptions,
  Store,
} from '../repo/types.js'
import { writeInParts } from '../repo/types.js'

export interface S3Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** "auto" for R2. */
  region?: string
  /**
   * fetch for the signed requests. The platform passes a guarded fetch for
   * customer endpoints (user-supplied URLs); the default is the global fetch,
   * with aws4fetch's retries.
   */
  fetch?: (req: Request) => Promise<Response>
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'S3Error'
  }
}

/** Keys are path segments; encode each one but keep the slashes. */
const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/')

const xmlValues = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) =>
    m[1]!
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'"),
  )

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A store over the S3 API (R2, S3, MinIO); presigns. */
export function s3Store(cfg: S3Config): S3Store {
  return new S3Store(cfg)
}

/** An enabled bucket lifecycle rule, as far as it touches stored objects. */
export interface LifecycleRule {
  id: string
  /** The key prefix it applies to ('' for the whole bucket). */
  prefix: string
  /** It deletes current objects (Expiration). */
  expires: boolean
  /** It moves objects to another storage class (Transition), where reads may fail. */
  transitions: boolean
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null

export const s3CopyLimits = {
  /** CopyObject's limit; larger objects are copied in parts. */
  copyObjectMax: 5 * 1024 ** 3,
  /** Part size for multipart copies: 512 MiB, so 10,000 parts cover 5 TiB. */
  partBytes: 512 * 1024 ** 2,
}

export class S3Store implements Store {
  readonly #aws: AwsClient
  readonly #base: string
  readonly #custom: S3Config['fetch']

  constructor(cfg: S3Config) {
    this.#custom = cfg.fetch
    this.#aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: cfg.region ?? 'auto',
      retries: 3,
    })
    this.#base = `${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}`
  }

  async #fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const custom = this.#custom
    if (!custom) return this.#aws.fetch(url, init)
    // Signed once, sent through the given fetch, retried on network errors and 5xx.
    const req = await this.#aws.sign(url, init)
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await custom(req.clone())
        if (res.status < 500 || attempt >= 2) return res
        await res.body?.cancel()
      } catch (err) {
        if (attempt >= 2) throw err
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt))
    }
  }

  readonly presigner: Presigner = {
    presignGet: (key, opts) => this.#presignGet(key, opts),
    presignPut: (key, opts) => this.#presignPut(key, opts),
    createMultipart: (key, type) => this.#createMultipart(key, type),
    presignPart: (key, id, n, exp) => this.#presignPart(key, id, n, exp),
    completeMultipart: (key, id, parts) => this.#completeMultipart(key, id, parts),
    abortMultipart: (key, id) => this.#abortMultipart(key, id),
  }

  #url(key: string, query?: Record<string, string>) {
    const u = new URL(`${this.#base}/${encodeKey(key)}`)
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v)
    return u.toString()
  }

  async #fail(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => '')
    throw new S3Error(
      res.status,
      `S3 ${what}: ${res.status} ${xmlValues(body, 'Code')[0] ?? body.slice(0, 200)}`,
    )
  }

  #head(res: Response): BlobHead {
    return {
      size: Number(res.headers.get('content-length') ?? 0),
      etag: res.headers.get('etag') ?? '',
      contentType: res.headers.get('content-type'),
    }
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null> {
    const headers: Record<string, string> = {}
    if (range) {
      headers.range =
        range.length === undefined
          ? `bytes=${range.offset}-`
          : `bytes=${range.offset}-${range.offset + range.length - 1}`
    }
    const res = await this.#fetch(this.#url(key), { headers })
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) return this.#fail(res, `GET ${key}`)
    const head = this.#head(res)
    let used = false
    const take = () => {
      if (used) throw new Error('Blob body already consumed')
      used = true
      return res
    }
    return {
      ...head,
      get body() {
        return take().body!
      },
      bytes: async () => new Uint8Array(await take().arrayBuffer()),
      text: async () => take().text(),
    }
  }

  async head(key: string): Promise<BlobHead | null> {
    const res = await this.#fetch(this.#url(key), { method: 'HEAD' })
    if (res.status === 404) return null
    if (!res.ok) return this.#fail(res, `HEAD ${key}`)
    return this.#head(res)
  }

  async put(key: string, body: Uint8Array | string, opts: PutOptions = {}): Promise<void> {
    const headers: Record<string, string> = {}
    if (opts.contentType) headers['content-type'] = opts.contentType
    if (opts.ifAbsent) headers['if-none-match'] = '*'
    const res = await this.#fetch(this.#url(key), {
      method: 'PUT',
      headers,
      body: body as BodyInit,
    })
    // 412: the key exists and ifAbsent was asked for. Keys are immutable, so that's success.
    if (res.status === 412 && opts.ifAbsent) {
      await res.body?.cancel()
      return
    }
    if (!res.ok) return this.#fail(res, `PUT ${key}`)
    await res.body?.cancel()
  }

  async delete(key: string): Promise<void> {
    const res = await this.#fetch(this.#url(key), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) return this.#fail(res, `DELETE ${key}`)
    await res.body?.cancel()
  }

  async list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }> {
    const u = new URL(this.#base)
    u.searchParams.set('list-type', '2')
    u.searchParams.set('prefix', prefix)
    if (cursor) u.searchParams.set('continuation-token', cursor)
    const res = await this.#fetch(u.toString())
    if (!res.ok) return this.#fail(res, `LIST ${prefix}`)
    const xml = await res.text()
    const next = xmlValues(xml, 'NextContinuationToken')[0]
    const keys = xmlValues(xml, 'Key')
    return next ? { keys, cursor: next } : { keys }
  }

  async #presign(url: string, method: string, expiresIn: number, headers?: Record<string, string>) {
    const u = new URL(url)
    u.searchParams.set('X-Amz-Expires', String(expiresIn))
    const signed = await this.#aws.sign(u.toString(), {
      method,
      ...(headers ? { headers } : {}),
      aws: { signQuery: true },
    })
    return signed.url
  }

  #presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    const q: Record<string, string> = {}
    if (opts.disposition) q['response-content-disposition'] = opts.disposition
    if (opts.contentType) q['response-content-type'] = opts.contentType
    return this.#presign(this.#url(key, q), 'GET', opts.expiresIn)
  }

  /** A multipart upload, each part a signed UploadPart: no presigned URLs, no whole object held. */
  async putParts(
    key: string,
    parts: AsyncIterable<Uint8Array>,
    opts: PutPartsOptions = {},
  ): Promise<void> {
    const { check, ...put } = opts
    if (opts.ifAbsent && (await this.head(key))) return
    await writeInParts(parts, check, {
      single: (bytes) => this.put(key, bytes, put),
      begin: async () => {
        const id = await this.#createMultipart(key, opts.contentType)
        return {
          part: async (partNumber, bytes) => {
            const res = await this.#fetch(
              this.#url(key, { partNumber: String(partNumber), uploadId: id }),
              { method: 'PUT', body: bytes as BodyInit },
            )
            if (!res.ok) return this.#fail(res, `UploadPart ${partNumber} of ${key}`)
            await res.body?.cancel()
            return { partNumber, etag: res.headers.get('etag') ?? '' }
          },
          complete: (done) => this.#completeMultipart(key, id, done),
          abort: () => this.#abortMultipart(key, id),
        }
      },
    })
  }

  /**
   * The bucket's enabled lifecycle rules: 'none' when it has none, 'unreadable'
   * when these credentials may not read them (GetBucketLifecycleConfiguration).
   */
  async lifecycleRules(): Promise<LifecycleRule[] | 'none' | 'unreadable'> {
    const res = await this.#fetch(this.#url('', { lifecycle: '' }))
    const text = await res.text()
    if (res.status === 404 || text.includes('NoSuchLifecycleConfiguration')) return 'none'
    if (res.status === 403 || res.status === 401 || res.status === 501) return 'unreadable'
    if (!res.ok)
      throw new S3Error(res.status, `GetBucketLifecycleConfiguration: ${text.slice(0, 200)}`)
    const rules: LifecycleRule[] = []
    for (const m of text.matchAll(/<Rule>([\s\S]*?)<\/Rule>/g)) {
      const r = m[1]!
      if (tag(r, 'Status') !== 'Enabled') continue
      const filter = tag(r, 'Filter')
      // A rule limited to tagged objects never touches untagged ones (Underlay tags none).
      if (filter !== null && /<Tag>/.test(filter)) continue
      const prefix = (filter !== null ? tag(filter, 'Prefix') : tag(r, 'Prefix')) ?? ''
      rules.push({
        id: tag(r, 'ID') ?? '',
        prefix,
        expires: tag(r, 'Expiration') !== null,
        transitions: /<Transition>/.test(r),
      })
    }
    return rules.length ? rules : 'none'
  }

  #presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    return this.#presign(
      this.#url(key),
      'PUT',
      opts.expiresIn,
      opts.contentType ? { 'content-type': opts.contentType } : undefined,
    )
  }

  async #createMultipart(key: string, contentType?: string): Promise<string> {
    const res = await this.#fetch(`${this.#url(key)}?uploads`, {
      method: 'POST',
      headers: contentType ? { 'content-type': contentType } : {},
    })
    if (!res.ok) return this.#fail(res, `CreateMultipartUpload ${key}`)
    const id = xmlValues(await res.text(), 'UploadId')[0]
    if (!id) throw new S3Error(500, 'CreateMultipartUpload: no UploadId')
    return id
  }

  #presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return this.#presign(
      this.#url(key, { partNumber: String(partNumber), uploadId }),
      'PUT',
      expiresIn,
    )
  }

  async #completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>'
    const res = await this.#fetch(this.#url(key, { uploadId }), { method: 'POST', body: xml })
    const text = await res.text()
    // S3 can answer 200 with an <Error> body for a failed completion.
    if (!res.ok || text.includes('<Error>')) {
      throw new S3Error(
        res.ok ? 500 : res.status,
        `CompleteMultipartUpload ${key}: ${text.slice(0, 200)}`,
      )
    }
  }

  /**
   * CopyObject, or for an object over 5 GiB (CopyObject's limit; pass its size)
   * a multipart copy whose parts are UploadPartCopy ranges of the source.
   */
  async copy(from: string, to: string, size?: number): Promise<void> {
    const source = `/${this.#base.split('/').pop()}/${encodeKey(from)}`
    if (size !== undefined && size > s3CopyLimits.copyObjectMax)
      return this.#copyInParts(source, to, size)
    const res = await this.#fetch(this.#url(to), {
      method: 'PUT',
      headers: { 'x-amz-copy-source': source },
    })
    const text = await res.text()
    // Like CompleteMultipartUpload, CopyObject can answer 200 with an <Error> body.
    if (!res.ok || text.includes('<Error>')) {
      throw new S3Error(
        res.ok ? 500 : res.status,
        `CopyObject ${from} → ${to}: ${text.slice(0, 200)}`,
      )
    }
  }

  async #copyInParts(source: string, to: string, size: number): Promise<void> {
    const id = await this.#createMultipart(to)
    try {
      const parts: { partNumber: number; etag: string }[] = []
      for (let start = 0; start < size; start += s3CopyLimits.partBytes) {
        const partNumber = parts.length + 1
        const end = Math.min(size, start + s3CopyLimits.partBytes) - 1
        const res = await this.#fetch(
          this.#url(to, { partNumber: String(partNumber), uploadId: id }),
          {
            method: 'PUT',
            headers: {
              'x-amz-copy-source': source,
              'x-amz-copy-source-range': `bytes=${start}-${end}`,
            },
          },
        )
        const text = await res.text()
        const etag = /<ETag>(.*?)<\/ETag>/.exec(text)?.[1]
        if (!res.ok || text.includes('<Error>') || !etag) {
          throw new S3Error(
            res.ok ? 500 : res.status,
            `UploadPartCopy ${to}: ${text.slice(0, 200)}`,
          )
        }
        parts.push({ partNumber, etag: etag.replace(/&quot;/g, '"') })
      }
      await this.#completeMultipart(to, id, parts)
    } catch (err) {
      await this.#abortMultipart(to, id).catch(() => {})
      throw err
    }
  }

  async #abortMultipart(key: string, uploadId: string): Promise<void> {
    const res = await this.#fetch(this.#url(key, { uploadId }), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) return this.#fail(res, `AbortMultipartUpload ${key}`)
    await res.body?.cancel()
  }
}
