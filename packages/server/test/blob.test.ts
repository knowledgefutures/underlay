import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FsBlobStore, serveSignedBlob } from '../src/blob/fs.js'
import { MemoryBlobStore } from '../src/blob/memory.js'
import { S3BlobStore } from '../src/blob/s3.js'
import type { BlobStore } from '../src/ports.js'
import { type FakeS3, startFakeS3 } from './fake-s3.js'

const enc = new TextEncoder()

/** The contract every BlobStore satisfies. */
function contract(name: string, make: () => Promise<BlobStore>) {
  describe(`${name} blob store`, () => {
    let store: BlobStore
    beforeAll(async () => {
      store = await make()
    })

    it('puts, gets, heads, ranges and deletes', async () => {
      await store.put('a/b c/obj', 'hello world', { contentType: 'text/plain' })
      const obj = await store.get('a/b c/obj')
      expect(obj?.size).toBe(11)
      expect(await obj!.text()).toBe('hello world')
      expect((await store.head('a/b c/obj'))?.size).toBe(11)
      expect(await (await store.get('a/b c/obj', { offset: 6, length: 3 }))!.text()).toBe('wor')
      expect(await (await store.get('a/b c/obj', { offset: 6 }))!.text()).toBe('world')
      await store.delete('a/b c/obj')
      expect(await store.get('a/b c/obj')).toBe(null)
      expect(await store.head('a/b c/obj')).toBe(null)
    })

    it('treats ifAbsent on an existing key as success without overwriting', async () => {
      await store.put('immutable', 'first')
      await store.put('immutable', 'second', { ifAbsent: true })
      expect(await (await store.get('immutable'))!.text()).toBe('first')
    })

    it('streams bodies', async () => {
      await store.put('stream', enc.encode('x'.repeat(100_000)))
      const obj = await store.get('stream')
      const text = await new Response(obj!.body).text()
      expect(text.length).toBe(100_000)
    })

    it('lists by prefix', async () => {
      await store.put('list/1', '1')
      await store.put('list/2', '2')
      await store.put('other/3', '3')
      expect((await store.list('list/')).keys).toEqual(['list/1', 'list/2'])
    })

    it('presigns and completes multipart uploads', async () => {
      expect(await store.presignGet('x', { expiresIn: 60 })).toBeTruthy()
      expect(await store.presignPut('x', { expiresIn: 60 })).toBeTruthy()
      const id = await store.createMultipart('big')
      expect(await store.presignPart('big', id, 1, 60)).toBeTruthy()
      await store.abortMultipart('big', id)
    })
  })
}

contract('memory', async () => new MemoryBlobStore())

let dir: string
contract('fs', async () => {
  dir = await mkdtemp(join(tmpdir(), 'ul-blob-'))
  return new FsBlobStore({ root: dir, publicUrl: 'http://localhost:4100', secret: 's3cret' })
})
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

let s3: FakeS3
contract('s3', async () => {
  s3 = await startFakeS3()
  return new S3BlobStore({
    endpoint: s3.url,
    bucket: 'test',
    accessKeyId: 'k',
    secretAccessKey: 's',
  })
})
afterAll(async () => s3?.close())

describe('fs presigned URLs', () => {
  it('serve GET and PUT with a valid signature only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ul-blob-'))
    const store = new FsBlobStore({ root, publicUrl: 'http://localhost:4100', secret: 'k' })
    const put = await store.presignPut('uploads/u1', { expiresIn: 60 })
    const res = await serveSignedBlob(store, new Request(put, { method: 'PUT', body: 'bytes!' }))
    expect(res.status).toBe(200)
    const get = await store.presignGet('uploads/u1', { expiresIn: 60, disposition: 'attachment' })
    const got = await serveSignedBlob(store, new Request(get))
    expect(await got.text()).toBe('bytes!')
    expect(got.headers.get('content-disposition')).toBe('attachment')
    const tampered = get.replace('uploads%2Fu1', 'uploads%2Fu2').replace('uploads/u1', 'uploads/u2')
    expect((await serveSignedBlob(store, new Request(tampered))).status).toBe(403)
    const wrongMethod = await serveSignedBlob(store, new Request(get, { method: 'PUT', body: 'x' }))
    expect(wrongMethod.status).toBe(403)
    await rm(root, { recursive: true, force: true })
  })
})

describe('s3 multipart', () => {
  it('assembles parts uploaded to presigned part URLs', async () => {
    const fake = await startFakeS3()
    const store = new S3BlobStore({
      endpoint: fake.url,
      bucket: 'test',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
    const id = await store.createMultipart('files/big', 'application/octet-stream')
    const parts = []
    for (const [n, text] of [
      [1, 'part one,'],
      [2, 'part two'],
    ] as const) {
      const url = await store.presignPart('files/big', id, n, 60)
      expect(url).toContain('X-Amz-Signature')
      const r = await fetch(url, { method: 'PUT', body: text })
      parts.push({ partNumber: n, etag: r.headers.get('etag')! })
    }
    await store.completeMultipart('files/big', id, parts)
    expect(await (await store.get('files/big'))!.text()).toBe('part one,part two')
    await fake.close()
  })
})
