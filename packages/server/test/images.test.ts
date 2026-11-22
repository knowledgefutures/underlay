import { type MemoryStore, memoryStore } from '@underlay/protocol'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { sizedFormat } from '../src/api/images.js'
import { deleteOwnedAvatar } from '../src/lib/avatars.js'
import type { ImageResizer, SizedFormat } from '../src/ports.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const BASE = 'https://assets-staging.underlay.org'
const KEY = 'avatars/org1/cover-abc123.png'
const ORIGINAL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

let h: Harness
let store: MemoryStore
let calls: { width: number; format: SizedFormat }[]

/** A resizer that names what it was asked for, so a response shows which copy it is. */
const fake: ImageResizer = {
  async resize(_bytes, opts) {
    calls.push(opts)
    return new TextEncoder().encode(`${opts.width}.${opts.format}`)
  },
}

const get = (path: string, accept = 'image/avif,image/webp,*/*') =>
  h.request(path, { headers: { accept } })

beforeAll(async () => {
  h = await harness()
})

beforeEach(async () => {
  store = memoryStore()
  await store.put(KEY, ORIGINAL, { contentType: 'image/png' })
  h.ports.publicAssets = { store, baseUrl: BASE }
  h.ports.images = fake
  calls = []
})

describe('/img', () => {
  it('resizes once, keeps the copy beside the original, and serves it after', async () => {
    const res = await get(`/img/1280/${KEY}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/avif')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('vary')).toBe('accept')
    expect(await res.text()).toBe('1280.avif')
    expect(calls).toEqual([{ width: 1280, format: 'avif' }])
    await new Promise((r) => setTimeout(r, 0))
    const copy = store.objects.get('avatars/org1/sized/cover-abc123.png/1280.avif')
    expect(copy?.contentType).toBe('image/avif')

    const again = await get(`/img/1280/${KEY}`)
    expect(await again.text()).toBe('1280.avif')
    expect(calls).toHaveLength(1)
  })

  it('serves a kept copy when the cache has none', async () => {
    await store.put('avatars/org1/sized/cover-abc123.png/640.webp', new Uint8Array([7]))
    const res = await get(`/img/640/${KEY}`, 'image/webp,*/*')
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7]))
    expect(calls).toEqual([])
  })

  it('takes the format from Accept', () => {
    expect(sizedFormat('image/avif,image/webp,*/*', 'png')).toBe('avif')
    expect(sizedFormat('image/webp,*/*', 'png')).toBe('webp')
    expect(sizedFormat('*/*', 'jpg')).toBe('jpeg')
    expect(sizedFormat('*/*', 'png')).toBe('png')
    expect(sizedFormat('', 'webp')).toBe('png')
  })

  it('refuses widths it does not make and keys outside the org folders', async () => {
    expect((await get(`/img/1000/${KEY}`)).status).toBe(404)
    expect((await get('/img/640/records/abc.png')).status).toBe(404)
    expect((await get('/img/640/avatars/org1/../secret.png')).status).toBe(404)
    expect((await get('/img/640/avatars/org1/logo.svg')).status).toBe(404)
    expect((await get('/img/640/avatars/org1/missing.png')).status).toBe(404)
    expect(calls).toEqual([])
  })

  it('redirects to the original for GIFs, without the binding, and when a resize fails', async () => {
    await store.put('avatars/org1/anim.gif', new Uint8Array([1]))
    const gif = await get('/img/256/avatars/org1/anim.gif')
    expect(gif.status).toBe(302)
    expect(gif.headers.get('location')).toBe(`${BASE}/avatars/org1/anim.gif`)

    h.ports.images = {
      resize: async () => {
        throw new Error('bad image')
      },
    }
    const failed = await get(`/img/256/${KEY}`)
    expect(failed.status).toBe(302)
    expect(failed.headers.get('location')).toBe(`${BASE}/${KEY}`)

    delete h.ports.images
    const none = await get(`/img/2560/${KEY}`)
    expect(none.status).toBe(302)
  })

  it('deleting an image deletes its sized copies', async () => {
    await get(`/img/256/${KEY}`)
    await get(`/img/640/${KEY}`, 'image/webp')
    await new Promise((r) => setTimeout(r, 0))
    await store.put('avatars/org1/other.png', ORIGINAL)
    await deleteOwnedAvatar({ store, baseUrl: BASE }, 'org1', `${BASE}/${KEY}`)
    expect([...store.objects.keys()]).toEqual(['avatars/org1/other.png'])
  })
})
