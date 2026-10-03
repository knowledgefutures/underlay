/**
 * A tiny S3-compatible server for adapter tests: path-style GET (with Range), PUT
 * (with If-None-Match), HEAD, DELETE, ListObjectsV2 and multipart uploads. It
 * checks that requests are signed (header or query) but doesn't verify
 * signatures; signing itself is aws4fetch's.
 */
import { createServer, type Server } from 'node:http'

export interface FakeS3 {
  url: string
  objects: Map<string, { bytes: Buffer; contentType: string | undefined }>
  requests: { method: string; url: string }[]
  close(): Promise<void>
}

export async function startFakeS3(bucket = 'test'): Promise<FakeS3> {
  const objects = new Map<string, { bytes: Buffer; contentType: string | undefined }>()
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>()
  const requests: { method: string; url: string }[] = []

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, 'http://x')
    requests.push({ method: req.method!, url: req.url! })
    const signed =
      !!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256') ||
      url.searchParams.has('X-Amz-Signature')
    if (!signed) {
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

    if (req.method === 'GET' && !key && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? ''
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(
        `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`,
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
      up.parts.set(Number(q.get('partNumber')), body)
      res.writeHead(200, { etag: `"p${q.get('partNumber')}"` }).end()
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
      case 'PUT':
        if (req.headers['if-none-match'] === '*' && obj) {
          res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>')
          return
        }
        objects.set(key, { bytes: body, contentType: req.headers['content-type'] })
        res.writeHead(200, { etag: '"x"' }).end()
        return
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
