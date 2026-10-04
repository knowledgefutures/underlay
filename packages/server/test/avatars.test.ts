import { type MemoryStore, memoryStore } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AVATAR_MAX_BYTES, avatarRoutes, sniffRaster } from '../src/api/avatars.js'
import type { AppEnv } from '../src/app.js'
import * as schema from '../src/db/schema.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const BASE = 'https://assets-staging.underlay.org'
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (fill = 1, size = 64) => {
  const b = new Uint8Array(size).fill(fill)
  b.set(PNG)
  return b
}
const gif = () => new TextEncoder().encode('GIF89a\x01\x00\x01\x00')
const svg = () =>
  new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  )

/**
 * The avatar routes on the harness's ports, mounted after middleware like
 * app.ts's. `x-test-user` signs in; `x-test-scope` makes it an API key with that
 * scope, `x-test-collections` limits it to collections, `x-test-org` makes it
 * an org-owned key.
 */
function avatarApp(h: Harness) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('ports', h.ports)
    c.set('config', { appUrl: 'https://ul.test', deployment: 'test' })
    const user = c.req.header('x-test-user')
    const scope = (c.req.header('x-test-scope') ?? 'session') as 'session' | 'read' | 'write'
    const cols = c.req.header('x-test-collections')
    const org = c.req.header('x-test-org')
    c.set(
      'principal',
      user
        ? {
            userId: user,
            scope,
            collectionIds: cols ? cols.split(',') : null,
            ...(org ? { orgId: org } : {}),
          }
        : null,
    )
    await next()
  })
  app.route('/', avatarRoutes())
  return app
}

let h: Harness
let app: ReturnType<typeof avatarApp>
let store: MemoryStore

interface Opts {
  user?: string
  scope?: string
  collections?: string
  org?: string
}

function headers(o: Opts) {
  const hs = new Headers()
  if (o.user) hs.set('x-test-user', o.user)
  if (o.scope) hs.set('x-test-scope', o.scope)
  if (o.collections) hs.set('x-test-collections', o.collections)
  if (o.org) hs.set('x-test-org', o.org)
  return hs
}

function upload(bytes: Uint8Array, type: string, o: Opts = { user: 'u1' }, name = 'logo') {
  const form = new FormData()
  form.append('avatar', new File([bytes as BlobPart], name, { type }))
  return app.fetch(
    new Request('http://test/api/accounts/org/avatar', {
      method: 'POST',
      headers: headers(o),
      body: form,
    }),
  )
}

function remove(o: Opts = { user: 'u1' }) {
  return app.fetch(
    new Request('http://test/api/accounts/org/avatar', { method: 'DELETE', headers: headers(o) }),
  )
}

async function avatarUrl() {
  const [org] = await h.ports.db
    .select({ avatarUrl: schema.organization.avatarUrl })
    .from(schema.organization)
    .where(eq(schema.organization.id, 'org1'))
  return org!.avatarUrl
}

async function setAvatarUrl(url: string | null) {
  await h.ports.db
    .update(schema.organization)
    .set({ avatarUrl: url })
    .where(eq(schema.organization.id, 'org1'))
}

beforeAll(async () => {
  h = await harness()
  await h.member('u1')
  for (const [id, role] of [
    ['u-admin', 'admin'],
    ['u-member', 'member'],
  ] as const) {
    await h.ports.db.insert(schema.user).values({ id, name: id, email: `${id}@example.org` })
    await h.ports.db.insert(schema.member).values({ organizationId: 'org1', userId: id, role })
  }
  await h.ports.db.insert(schema.user).values({ id: 'stranger', name: 's', email: 's@x.org' })
  app = avatarApp(h)
})

beforeEach(async () => {
  store = memoryStore()
  h.ports.publicAssets = { store, baseUrl: BASE }
  await setAvatarUrl(null)
})

describe('org avatars', () => {
  it('an owner uploads a logo, then removes it', async () => {
    const res = await upload(png(), 'image/png')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; avatarUrl: string }
    expect(body.ok).toBe(true)
    expect(body.avatarUrl).toMatch(new RegExp(`^${BASE}/avatars/org1/[0-9a-f]{64}\\.png$`))
    expect(await avatarUrl()).toBe(body.avatarUrl)

    const key = body.avatarUrl.slice(BASE.length + 1)
    const obj = store.objects.get(key)
    expect(obj?.contentType).toBe('image/png')
    expect(obj?.cacheControl).toBe('public, max-age=31536000, immutable')
    expect(obj?.bytes).toEqual(png())

    const del = await remove()
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    expect(await avatarUrl()).toBeNull()
    expect(store.objects.has(key)).toBe(false)
  })

  it('is mounted on the app', async () => {
    const form = new FormData()
    form.append('avatar', new File([png() as BlobPart], 'logo.png', { type: 'image/png' }))
    const res = await h.request('/api/accounts/org/avatar', {
      method: 'POST',
      user: 'u1',
      body: form,
    })
    expect(res.status).toBe(200)
    expect((await h.request('/api/accounts/org/avatar', { method: 'DELETE' })).status).toBe(401)
  })

  it('replacing a logo deletes the old one; re-uploading the same image keeps it', async () => {
    const first = ((await (await upload(png(), 'image/png')).json()) as { avatarUrl: string })
      .avatarUrl
    const again = ((await (await upload(png(), 'image/png')).json()) as { avatarUrl: string })
      .avatarUrl
    expect(again).toBe(first)
    expect(store.objects.has(first.slice(BASE.length + 1))).toBe(true)

    const second = ((await (await upload(gif(), 'image/gif')).json()) as { avatarUrl: string })
      .avatarUrl
    expect(second).toMatch(/\.gif$/)
    expect(store.objects.has(first.slice(BASE.length + 1))).toBe(false)
    expect([...store.objects.keys()]).toEqual([second.slice(BASE.length + 1)])
  })

  it('stores the type the bytes show, not the declared one', async () => {
    const res = await upload(png(), 'image/jpeg', { user: 'u1' }, 'logo.jpg')
    expect(res.status).toBe(200)
    const { avatarUrl } = (await res.json()) as { avatarUrl: string }
    expect(avatarUrl).toMatch(/\.png$/)
    expect(store.objects.get(avatarUrl.slice(BASE.length + 1))?.contentType).toBe('image/png')
  })

  it('owners only: admins, members, strangers, read and scoped keys are refused', async () => {
    expect((await upload(png(), 'image/png', {})).status).toBe(401)
    for (const o of [
      { user: 'u-admin' },
      { user: 'u-member' },
      { user: 'stranger' },
      { user: 'u1', scope: 'read' },
      { user: 'u1', scope: 'write', collections: 'c1' },
      { user: 'u1', scope: 'write', org: 'some-other-org' },
    ]) {
      expect((await upload(png(), 'image/png', o)).status, JSON.stringify(o)).toBe(403)
      expect((await remove(o)).status, JSON.stringify(o)).toBe(403)
    }
    expect(store.objects.size).toBe(0)
    // An org-owned key acts as its org.
    expect(
      (await upload(png(), 'image/png', { user: 'k', scope: 'write', org: 'org1' })).status,
    ).toBe(200)
  })

  it('404s an unknown org', async () => {
    const res = await app.fetch(
      new Request('http://test/api/accounts/nope/avatar', {
        method: 'DELETE',
        headers: headers({ user: 'u1' }),
      }),
    )
    expect(res.status).toBe(404)
  })

  it('rejects SVG and files whose bytes are not a raster image', async () => {
    expect((await upload(svg(), 'image/svg+xml')).status).toBe(422)
    expect((await upload(svg(), 'image/png', { user: 'u1' }, 'logo.png')).status).toBe(422)
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    expect((await upload(html, 'image/gif', { user: 'u1' }, 'logo.gif')).status).toBe(422)
    // A real PNG declared as something that isn't an allowed image type.
    expect((await upload(png(), 'text/html')).status).toBe(422)
    expect(store.objects.size).toBe(0)
    expect(await avatarUrl()).toBeNull()
  })

  it('413s a file over the cap, whether or not the body is', async () => {
    // Just over: the body fits the multipart allowance, the file doesn't.
    expect((await upload(png(1, AVATAR_MAX_BYTES + 1), 'image/png')).status).toBe(413)
    // Far over: refused while reading the body.
    expect((await upload(png(1, 3 * AVATAR_MAX_BYTES), 'image/png')).status).toBe(413)
    expect((await upload(png(1, AVATAR_MAX_BYTES), 'image/png')).status).toBe(200)
  })

  it('400s a body that is not multipart, or has no file', async () => {
    const res = await app.fetch(
      new Request('http://test/api/accounts/org/avatar', {
        method: 'POST',
        headers: { ...Object.fromEntries(headers({ user: 'u1' })), 'content-type': 'image/png' },
        body: png() as BodyInit,
      }),
    )
    expect(res.status).toBe(400)
    const form = new FormData()
    form.append('name', 'not a file')
    const empty = await app.fetch(
      new Request('http://test/api/accounts/org/avatar', {
        method: 'POST',
        headers: headers({ user: 'u1' }),
        body: form,
      }),
    )
    expect(empty.status).toBe(400)
  })

  it("never deletes a migrated logo on another host, or outside the org's folder", async () => {
    // v1's URL, in production's bucket. Seed the same key here to prove it isn't touched.
    const migrated = 'https://assets.underlay.org/avatars/org1/1700000000000.png'
    store.objects.set('avatars/org1/1700000000000.png', { bytes: png(), contentType: 'image/png' })
    await setAvatarUrl(migrated)
    expect((await upload(gif(), 'image/gif')).status).toBe(200)
    expect(store.objects.has('avatars/org1/1700000000000.png')).toBe(true)

    await setAvatarUrl(migrated)
    expect((await remove()).status).toBe(200)
    expect(await avatarUrl()).toBeNull()
    expect(store.objects.has('avatars/org1/1700000000000.png')).toBe(true)

    // Same host, another org's folder.
    store.objects.set('avatars/org2/x.png', { bytes: png(), contentType: 'image/png' })
    await setAvatarUrl(`${BASE}/avatars/org2/x.png`)
    expect((await remove()).status).toBe(200)
    expect(store.objects.has('avatars/org2/x.png')).toBe(true)
  })

  it('deletes a v1-style logo under this deployment, as on prod', async () => {
    store.objects.set('avatars/org1/1700000000000.png', { bytes: png(), contentType: 'image/png' })
    await setAvatarUrl(`${BASE}/avatars/org1/1700000000000.png`)
    expect((await upload(gif(), 'image/gif')).status).toBe(200)
    expect(store.objects.has('avatars/org1/1700000000000.png')).toBe(false)
  })

  it('503s, without changing anything, when the deployment has no public assets bucket', async () => {
    delete h.ports.publicAssets
    await setAvatarUrl('https://assets.underlay.org/avatars/org1/1.png')
    expect((await upload(png(), 'image/png')).status).toBe(503)
    expect((await remove()).status).toBe(503)
    expect(await avatarUrl()).toBe('https://assets.underlay.org/avatars/org1/1.png')
  })
})

describe('sniffRaster', () => {
  it('knows PNG, JPEG, GIF and WebP by their magic bytes', () => {
    const riff = new TextEncoder().encode('RIFF\x00\x00\x00\x00WEBPVP8 ')
    expect(sniffRaster(png())?.type).toBe('image/png')
    expect(sniffRaster(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg')
    expect(sniffRaster(gif())?.type).toBe('image/gif')
    expect(sniffRaster(riff)?.type).toBe('image/webp')
    expect(sniffRaster(svg())).toBeNull()
    expect(sniffRaster(new TextEncoder().encode('RIFF\x00\x00\x00\x00WAVE'))).toBeNull()
    expect(sniffRaster(new Uint8Array())).toBeNull()
  })
})
