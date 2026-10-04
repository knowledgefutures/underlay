/**
 * A tiny S3-compatible server for adapter tests: path-style GET (with Range), PUT
 * (with If-None-Match), HEAD, DELETE, ListObjectsV2 and multipart uploads. It
 * checks that requests are signed (header or query) but doesn't verify
 * signatures; signing itself is aws4fetch's.
 */
import { createServer, type Server } from 'node:http'

export interface FakeS3 {
  url: string
  objects: Map<
    string,
    { bytes: Buffer; contentType: string | undefined; cacheControl?: string | undefined }
  >
  requests: { method: string; url: string }[]
  /** The bucket's lifecycle configuration XML (null: none); `'denied'` refuses reading it. */
  lifecycle: { xml: string | null | 'denied' }
  close(): Promise<void>
}

export async function startFakeS3(
  bucket = 'test',
  listenPort = 0,
  /** region: refuse requests signed for another region, as S3 does, and name it on a bucket HEAD. */
  opts: { publicRead?: boolean; region?: string } = {},
): Promise<FakeS3> {
  const objects: FakeS3['objects'] = new Map()
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>()
  const requests: { method: string; url: string }[] = []
  const lifecycle: FakeS3['lifecycle'] = { xml: null }

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, 'http://x')
    requests.push({ method: req.method!, url: req.url! })
    const signed =
      !!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256') ||
      url.searchParams.has('X-Amz-Signature')
    if (opts.region) {
      const scope =
        /Credential=[^/]+\/\d+\/([^/]+)\//.exec(req.headers.authorization ?? '')?.[1] ??
        url.searchParams.get('X-Amz-Credential')?.split('/')[2]
      const where = { 'x-amz-bucket-region': opts.region }
      if (req.method === 'HEAD' && url.pathname.split('/').filter(Boolean).length === 1)
        return void res.writeHead(scope === opts.region ? 200 : 403, where).end()
      if (signed && scope !== opts.region)
        return void res
          .writeHead(400, where)
          .end('<Error><Code>AuthorizationHeaderMalformed</Code></Error>')
    }
    if (!signed && !(opts.publicRead && req.method === 'GET')) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>')
      return
    }
    const [, b, ...rest] = url.pathname.split('/')
    if (b !== bucket) {
      res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>')
      return
    }
    const key = rest.map(decodeURIComponent).join('/')
    const q = url.searchParams

    if (req.method === 'GET' && !key && q.has('lifecycle')) {
      if (lifecycle.xml === 'denied')
        return void res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>')
      if (lifecycle.xml === null)
        return void res
          .writeHead(404)
          .end('<Error><Code>NoSuchLifecycleConfiguration</Code></Error>')
      res.writeHead(200, { 'content-type': 'application/xml' }).end(lifecycle.xml)
      return
    }
    if (req.method === 'GET' && !key && q.get('list-type') === '2') {
      // Pages of max-keys (1,000 by default), with an opaque continuation token.
      const prefix = q.get('prefix') ?? ''
      const max = Number(q.get('max-keys') ?? 1000)
      const token = q.get('continuation-token')
      const after = token ? Buffer.from(token, 'base64url').toString() : null
      const all = [...objects.keys()]
        .filter((k) => k.startsWith(prefix) && (after === null || k > after))
        .sort()
      const keys = all.slice(0, max)
      const next =
        all.length > max
          ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${Buffer.from(keys[keys.length - 1]!).toString('base64url')}</NextContinuationToken>`
          : '<IsTruncated>false</IsTruncated>'
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(
        `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}${next}</ListBucketResult>`,
      )
      return
    }
    if (req.method === 'POST' && q.has('uploads')) {
      const id = crypto.randomUUID()
      uploads.set(id, { key, parts: new Map() })
      res
        .writeHead(200)
        .end(
          `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        )
      return
    }
    if (req.method === 'PUT' && q.has('uploadId')) {
      const up = uploads.get(q.get('uploadId')!)
      if (!up) return void res.writeHead(404).end('<Error><Code>NoSuchUpload</Code></Error>')
      const n = q.get('partNumber')
      // UploadPartCopy: the part is a range of another object.
      const copySource = req.headers['x-amz-copy-source']
      if (typeof copySource === 'string') {
        const src = objects.get(decodeURIComponent(copySource.replace(/^\/[^/]+\//, '')))
        if (!src) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
        const r = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers['x-amz-copy-source-range'] ?? ''))
        up.parts.set(
          Number(n),
          r ? src.bytes.subarray(Number(r[1]), Number(r[2]) + 1) : Buffer.from(src.bytes),
        )
        res.writeHead(200).end(`<CopyPartResult><ETag>"c${n}"</ETag></CopyPartResult>`)
        return
      }
      up.parts.set(Number(n), body)
      res.writeHead(200, { etag: `"p${n}"` }).end()
      return
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const up = uploads.get(q.get('uploadId')!)
      if (!up) return void res.writeHead(404).end('<Error><Code>NoSuchUpload</Code></Error>')
      const nums = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) =>
        Number(m[1]),
      )
      objects.set(up.key, {
        bytes: Buffer.concat(nums.map((n) => up.parts.get(n)!)),
        contentType: undefined,
      })
      uploads.delete(q.get('uploadId')!)
      res.writeHead(200).end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>')
      return
    }
    if (req.method === 'DELETE' && q.has('uploadId')) {
      uploads.delete(q.get('uploadId')!)
      res.writeHead(204).end()
      return
    }
    const obj = objects.get(key)
    switch (req.method) {
      case 'PUT': {
        const copySource = req.headers['x-amz-copy-source']
        if (typeof copySource === 'string') {
          const srcKey = decodeURIComponent(copySource.replace(/^\/[^/]+\//, ''))
          const src = objects.get(srcKey)
          if (!src) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
          objects.set(key, { bytes: Buffer.from(src.bytes), contentType: src.contentType })
          res.writeHead(200).end('<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>')
          return
        }
        if (req.headers['if-none-match'] === '*' && obj) {
          res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>')
          return
        }
        objects.set(key, {
          bytes: body,
          contentType: req.headers['content-type'],
          cacheControl: req.headers['cache-control'],
        })
        res.writeHead(200, { etag: '"x"' }).end()
        return
      }
      case 'HEAD':
      case 'GET': {
        if (!obj)
          return void res
            .writeHead(404)
            .end(req.method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : undefined)
        let bytes = obj.bytes
        let status = 200
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
        if (range) {
          const start = Number(range[1])
          const end = range[2] ? Number(range[2]) : bytes.length - 1
          bytes = bytes.subarray(start, end + 1)
          status = 206
        }
        const headers: Record<string, string> = {
          'content-length': String(bytes.length),
          etag: '"x"',
        }
        if (obj.contentType) headers['content-type'] = obj.contentType
        if (obj.cacheControl) headers['cache-control'] = obj.cacheControl
        res.writeHead(status, headers)
        res.end(req.method === 'GET' ? bytes : undefined)
        return
      }
      case 'DELETE':
        objects.delete(key)
        res.writeHead(204).end()
        return
    }
    res.writeHead(400).end()
  })
  await new Promise<void>((r) => server.listen(listenPort, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    requests,
    lifecycle,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
