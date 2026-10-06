/**
 * The store contract: what every store does, run against all of them, plain
 * and under a prefix. memory, file, s3 (an in-process fake of the S3 API), and
 * r2 (Miniflare's R2 binding).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  copyObject,
  fileStore,
  listAll,
  memoryStore,
  MIN_PART_BYTES,
  PrefixedStore,
  putFromParts,
  type R2BucketLike,
  readParts,
  r2Store,
  s3CopyLimits,
  s3Store,
  serveSignedBlob,
  type Store,
} from '../../src/index.js'
import { type FakeS3, startFakeS3 } from './fake-s3.js'

const enc = new TextEncoder()
const cleanups: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ul-store-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function fakeS3Store() {
  const fake: FakeS3 = await startFakeS3()
  cleanups.push(() => fake.close())
  return s3Store({ endpoint: fake.url, bucket: 'test', accessKeyId: 'k', secretAccessKey: 's' })
}

async function miniflareStore() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch: () => new Response() }',
      compatibilityDate: '2026-09-01',
      r2Buckets: ['B'],
    }),
  )
  cleanups.push(() => mf.dispose())
  return r2Store((await mf.getR2Bucket('B')) as unknown as R2BucketLike)
}

const makers: [string, () => Promise<Store>][] = [
  ['memory', async () => memoryStore()],
  ['file', async () => fileStore(await tempDir())],
  ['s3', fakeS3Store],
  ['r2', miniflareStore],
  ['prefixed memory', async () => new PrefixedStore(memoryStore(), 'some/prefix')],
  ['prefixed s3', async () => new PrefixedStore(await fakeS3Store(), 'some/prefix')],
  ['prefixed r2', async () => new PrefixedStore(await miniflareStore(), 'p')],
]

for (const [name, make] of makers) {
  describe(`${name} store`, () => {
    let store: Store
    beforeAll(async () => {
      store = await make()
    })

    it('puts, gets, heads, reads ranges and deletes', async () => {
      await store.put('a/b c/obj', 'hello world', { contentType: 'text/plain' })
      const obj = await store.get('a/b c/obj')
      expect(obj?.size).toBe(11)
      expect(obj?.contentType).toBe('text/plain')
      expect(await obj!.text()).toBe('hello world')
      const head = await store.head('a/b c/obj')
      expect(head?.size).toBe(11)
      expect(head?.contentType).toBe('text/plain')
      const mid = await store.get('a/b c/obj', { offset: 6, length: 3 })
      expect(mid?.size).toBe(3)
      expect(await mid!.text()).toBe('wor')
      const tail = await store.get('a/b c/obj', { offset: 6 })
      expect(tail?.size).toBe(5)
      expect(await tail!.text()).toBe('world')
      const clipped = await store.get('a/b c/obj', { offset: 9, length: 10 })
      expect(clipped?.size).toBe(2)
      expect(await clipped!.text()).toBe('ld')
      await store.delete('a/b c/obj')
      expect(await store.get('a/b c/obj')).toBe(null)
      expect(await store.head('a/b c/obj')).toBe(null)
    })

    it('answers null for absent keys and deletes them without complaint', async () => {
      expect(await store.get('absent')).toBe(null)
      expect(await store.get('absent', { offset: 0, length: 1 })).toBe(null)
      expect(await store.head('absent')).toBe(null)
      await store.delete('absent')
    })

    it('round-trips bytes exactly', async () => {
      const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7919) & 0xff)
      await store.put('bin', bytes)
      expect(await (await store.get('bin'))!.bytes()).toEqual(bytes)
      expect(await (await store.get('bin', { offset: 65_536, length: 10 }))!.bytes()).toEqual(
        bytes.subarray(65_536, 65_546),
      )
    })

    it('treats ifAbsent on an existing key as success without overwriting', async () => {
      await store.put('immutable', 'first')
      await store.put('immutable', 'second', { ifAbsent: true })
      expect(await (await store.get('immutable'))!.text()).toBe('first')
      await store.put('fresh', 'only', { ifAbsent: true })
      expect(await (await store.get('fresh'))!.text()).toBe('only')
    })

    it('streams bodies', async () => {
      await store.put('stream', enc.encode('x'.repeat(100_000)))
      const obj = await store.get('stream')
      expect((await new Response(obj!.body).text()).length).toBe(100_000)
    })

    it('writes from parts, and a failed check leaves nothing behind', async () => {
      async function* parts(n: number, size: number) {
        for (let i = 0; i < n; i++) yield new Uint8Array(size).fill(65 + i)
      }
      await putFromParts(store, 'parts/ok', parts(3, 1000), { contentType: 'text/plain' })
      const obj = await store.get('parts/ok')
      expect(obj!.size).toBe(3000)
      expect((await obj!.text()).slice(995, 1005)).toBe('AAAAABBBBB')
      await expect(
        putFromParts(store, 'parts/bad', parts(2, 10), {
          check: () => {
            throw new Error('hash mismatch')
          },
        }),
      ).rejects.toThrow('hash mismatch')
      expect(await store.head('parts/bad')).toBeNull()
      await putFromParts(store, 'parts/ok', parts(1, 5), { ifAbsent: true })
      expect((await store.head('parts/ok'))!.size).toBe(3000)
      await putFromParts(store, 'parts/empty', parts(0, 0))
      expect((await store.head('parts/empty'))!.size).toBe(0)
      // Big enough for a real multipart upload: two full parts and a short one.
      const big = MIN_PART_BYTES
      await putFromParts(
        store,
        'parts/big',
        (async function* () {
          yield* parts(2, big)
          yield new Uint8Array(7).fill(90)
        })(),
      )
      expect((await store.head('parts/big'))!.size).toBe(2 * big + 7)
      const tail = await store.get('parts/big', { offset: big - 2, length: 4 })
      expect(await tail!.text()).toBe('AABB')
      await expect(
        putFromParts(store, 'parts/big-bad', parts(3, big), {
          check: () => {
            throw new Error('size mismatch')
          },
        }),
      ).rejects.toThrow('size mismatch')
      expect(await store.head('parts/big-bad')).toBeNull()
      // readParts gives back the same bytes in ranges.
      const back: number[] = []
      for await (const p of readParts(store, 'parts/ok', 3000, 1024)) back.push(p.byteLength)
      expect(back).toEqual([1024, 1024, 952])
    })

    it('copies, natively or by reading and writing', async () => {
      await store.put('copy/src', 'copied bytes', { contentType: 'text/plain' })
      await copyObject(store, 'copy/src', 'copy/dest/x')
      expect(await (await store.get('copy/dest/x'))!.text()).toBe('copied bytes')
    })

    it('lists by prefix in byte order', async () => {
      for (const k of ['list/b', 'list/a', 'list/c/d', 'listing', 'other/3']) await store.put(k, k)
      expect((await store.list('list/')).keys).toEqual(['list/a', 'list/b', 'list/c/d'])
      expect((await store.list('list')).keys).toEqual(['list/a', 'list/b', 'list/c/d', 'listing'])
    })

    it('pages through more than 1,000 keys with opaque cursors', async () => {
      const keys = Array.from({ length: 1005 }, (_, i) => `many/${String(i).padStart(4, '0')}`)
      for (let i = 0; i < keys.length; i += 50) {
        await Promise.all(keys.slice(i, i + 50).map((k) => store.put(k, '')))
      }
      const first = await store.list('many/')
      expect(first.keys.length).toBeLessThan(1005)
      expect(first.cursor).toBeDefined()
      const all: string[] = []
      for await (const k of listAll(store, 'many/')) all.push(k)
      expect(all).toEqual(keys)
    }, 30_000)

    it('presigns, when it can', async () => {
      const p = store.presigner
      if (!p) return
      expect(await p.presignGet('x', { expiresIn: 60 })).toBeTruthy()
      expect(await p.presignPut('x', { expiresIn: 60 })).toBeTruthy()
      const id = await p.createMultipart('big')
      expect(await p.presignPart('big', id, 1, 60)).toBeTruthy()
      await p.abortMultipart('big', id)
    })
  })
}

describe('capabilities', () => {
  it('the r2 store neither presigns nor copies; s3 does both', async () => {
    const r2 = await miniflareStore()
    expect(r2.presigner).toBeUndefined()
    expect(r2.copy).toBeUndefined()
    const s3 = await fakeS3Store()
    expect(s3.presigner).toBeDefined()
    expect(s3.copy).toBeDefined()
    expect(fileStore('x').presigner).toBeUndefined()
    expect(new PrefixedStore(s3, 'p').presigner).toBeDefined()
  })
})

describe('cache-control on put', () => {
  const cc = 'public, max-age=31536000, immutable'
  it('s3 sends it with the object, and it is served back', async () => {
    const fake: FakeS3 = await startFakeS3()
    cleanups.push(() => fake.close())
    const store = s3Store({
      endpoint: fake.url,
      bucket: 'test',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
    await store.put('a.png', 'x', { contentType: 'image/png', cacheControl: cc })
    expect(fake.objects.get('a.png')?.cacheControl).toBe(cc)
    const res = await fetch(`${fake.url}/test/a.png`, {
      headers: { authorization: 'AWS4-HMAC-SHA256 test' },
    })
    expect(res.headers.get('cache-control')).toBe(cc)
  })

  it('r2 stores it in the http metadata', async () => {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch: () => new Response() }',
        compatibilityDate: '2026-09-01',
        r2Buckets: ['B'],
      }),
    )
    cleanups.push(() => mf.dispose())
    const bucket = await mf.getR2Bucket('B')
    await r2Store(bucket as unknown as R2BucketLike).put('a.png', 'x', {
      contentType: 'image/png',
      cacheControl: cc,
    })
    const head = await bucket.head('a.png')
    expect(head?.httpMetadata?.cacheControl).toBe(cc)
    expect(head?.httpMetadata?.contentType).toBe('image/png')
  })

  it('memory keeps it', async () => {
    const store = memoryStore()
    await store.put('a.png', 'x', { cacheControl: cc })
    expect(store.objects.get('a.png')?.cacheControl).toBe(cc)
  })
})

describe('file store presigned URLs', () => {
  it('serve GET and PUT with a valid signature only', async () => {
    const store = fileStore(await tempDir(), { publicUrl: 'http://localhost:4100', secret: 'k' })
    const put = await store.presigner.presignPut('uploads/u1', { expiresIn: 60 })
    const res = await serveSignedBlob(store, new Request(put, { method: 'PUT', body: 'bytes!' }))
    expect(res.status).toBe(200)
    const get = await store.presigner.presignGet('uploads/u1', {
      expiresIn: 60,
      disposition: 'attachment',
    })
    const got = await serveSignedBlob(store, new Request(get))
    expect(await got.text()).toBe('bytes!')
    expect(got.headers.get('content-disposition')).toBe('attachment')
    const tampered = get.replace('uploads%2Fu1', 'uploads%2Fu2').replace('uploads/u1', 'uploads/u2')
    expect((await serveSignedBlob(store, new Request(tampered))).status).toBe(403)
    const wrongMethod = await serveSignedBlob(store, new Request(get, { method: 'PUT', body: 'x' }))
    expect(wrongMethod.status).toBe(403)
  })
})

describe('s3 multipart copy', () => {
  it('copies an object over the CopyObject limit in UploadPartCopy ranges', async () => {
    const store = await fakeS3Store()
    const bytes = new Uint8Array(1000).map((_, i) => i % 251)
    await store.put('big/src', bytes)
    const saved = { ...s3CopyLimits }
    Object.assign(s3CopyLimits, { copyObjectMax: 100, partBytes: 300 })
    try {
      await copyObject(store, 'big/src', 'big/dest', 1000)
    } finally {
      Object.assign(s3CopyLimits, saved)
    }
    expect(await (await store.get('big/dest'))!.bytes()).toEqual(bytes)
  })
})

describe('s3 multipart', () => {
  it('assembles parts uploaded to presigned part URLs', async () => {
    const store = await fakeS3Store()
    const p = store.presigner
    const id = await p.createMultipart('files/big', 'application/octet-stream')
    const parts = []
    for (const [n, text] of [
      [1, 'part one,'],
      [2, 'part two'],
    ] as const) {
      const url = await p.presignPart('files/big', id, n, 60)
      expect(url).toContain('X-Amz-Signature')
      const r = await fetch(url, { method: 'PUT', body: text })
      parts.push({ partNumber: n, etag: r.headers.get('etag')! })
    }
    await p.completeMultipart('files/big', id, parts)
    expect(await (await store.get('files/big'))!.text()).toBe('part one,part two')
  })
})
