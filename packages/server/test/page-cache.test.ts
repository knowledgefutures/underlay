import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { createApp, type RenderPage } from '../src/app.js'
import * as schema from '../src/db/schema.js'
import { forgetDenylist } from '../src/lib/limits.js'
import { TTL_SECONDS } from '../src/page-cache.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const settle = () => new Promise((r) => setTimeout(r, 20))

async function setup() {
  const h = await harness()
  const user = await h.member()
  const c = await h.collection('c')
  await h.ports.db
    .update(schema.collections)
    .set({ public: true })
    .where(eq(schema.collections.id, c.id))
  const push = async (name: string) => {
    const res = await h.request('/api/collections/org/c/push', {
      method: 'POST',
      user,
      json: { schemas: { Author } },
    })
    const sid = ((await res.json()) as { session_id: string }).session_id
    await h.request(`/api/collections/org/c/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [{ id: 'a', type: 'Author', data: { name } }],
    })
    expect(
      (await h.request(`/api/collections/org/c/push/${sid}/commit`, { method: 'POST', user }))
        .status,
    ).toBe(201)
  }
  await push('first')
  let renders = 0
  let extra: Record<string, string> = {}
  let buildId = 'b1'
  const render = (async () => {
    renders++
    return new Response(`<p>render ${renders}</p>`, {
      headers: { 'content-type': 'text/html; charset=utf-8', ...extra },
    })
  }) as RenderPage
  Object.defineProperty(render, 'buildId', { get: () => buildId })
  const app = createApp(() => ({
    ports: h.ports,
    config: { appUrl: 'http://test', deployment: 'test' },
    authenticate: async (req) => {
      const u = req.headers.get('x-test-user')
      return u ? { userId: u, scope: 'session', collectionIds: null } : null
    },
    renderPage: render,
  }))
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await app.fetch(new Request(`http://test${path}`, { headers }))
    const body = await res.text()
    await settle()
    return { body, cache: res.headers.get('x-underlay-page-cache') }
  }
  return {
    h,
    user,
    c,
    push,
    get,
    renders: () => renders,
    setExtra: (e: Record<string, string>) => (extra = e),
    setBuild: (b: string) => (buildId = b),
  }
}

describe('the anonymous page cache', () => {
  it('serves an anonymous visitor a kept page, and no one else', async () => {
    const t = await setup()
    expect(await t.get('/explore')).toEqual({ body: '<p>render 1</p>', cache: 'miss' })
    expect(await t.get('/explore')).toEqual({ body: '<p>render 1</p>', cache: 'hit' })
    // Signed in, with any cookie, a key header, or a share token: rendered, and not kept.
    for (const [path, headers] of [
      ['/explore', { 'x-test-user': t.user }],
      ['/explore', { cookie: 'anything=1' }],
      ['/explore', { authorization: 'Bearer nope' }],
      ['/explore?token=abc', {}],
    ] as const) {
      const r = await t.get(path, headers)
      expect(r.cache).toBe(null)
    }
    const before = t.renders()
    expect((await t.get('/explore')).cache).toBe('hit')
    expect(t.renders()).toBe(before)
    // Forms, accounts, and settings are never kept; nor a page that sets a cookie.
    for (const path of ['/login', '/settings/keys', '/org/settings', '/org/c/settings']) {
      expect((await t.get(path)).cache).toBe(null)
    }
    t.setExtra({ 'set-cookie': 'x=1' })
    const n = t.renders()
    expect((await t.get('/docs/api')).cache).toBe(null)
    expect((await t.get('/docs/api')).cache).toBe(null)
    expect(t.renders()).toBe(n + 2)
  })

  it("keeps a collection's pages until it changes, and never once it is private", async () => {
    const t = await setup()
    expect((await t.get('/org/c')).cache).toBe('miss')
    expect((await t.get('/org/c/records')).cache).toBe('miss')
    expect((await t.get('/org/c')).cache).toBe('hit')
    // A push shows at once.
    await t.push('second')
    expect((await t.get('/org/c')).cache).toBe('miss')
    expect((await t.get('/org/c')).cache).toBe('hit')
    // Made private: rendered fresh every time (the real renderer says not found).
    await t.h.ports.db
      .update(schema.collections)
      .set({ public: false, updatedAt: new Date() })
      .where(eq(schema.collections.id, t.c.id))
    expect((await t.get('/org/c')).cache).toBe(null)
    expect((await t.get('/org/c')).cache).toBe(null)
  })

  it('renders anew after its time, a deploy, or a change to the denylist', async () => {
    const t = await setup()
    expect((await t.get('/')).cache).toBe('miss')
    expect((await t.get('/')).cache).toBe('hit')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + (TTL_SECONDS + 1) * 1000)
    try {
      expect((await t.get('/')).cache).toBe('miss')
    } finally {
      clock.mockRestore()
    }
    expect((await t.get('/')).cache).toBe('hit')
    t.setBuild('b2')
    expect((await t.get('/')).cache).toBe('miss')
    await t.h.ports.db
      .insert(schema.denylist)
      .values({ hash: 'f'.repeat(64), kind: 'record', reason: 't' })
    forgetDenylist(t.h.ports.db)
    expect((await t.get('/')).cache).toBe('miss')
    await t.h.ports.db.delete(schema.denylist)
    forgetDenylist(t.h.ports.db)
  })
})

describe('crawlers', () => {
  it('are kept off staging entirely, and off the API elsewhere', async () => {
    const h = await harness()
    const app = (deployment: string) =>
      createApp(() => ({
        ports: h.ports,
        config: { appUrl: 'http://test', deployment },
        authenticate: async () => null,
        renderPage: (async () =>
          new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } })) as RenderPage,
      }))
    const staging = app('staging')
    let res = await staging.fetch(new Request('http://test/robots.txt'))
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    for (const path of ['/', '/org/c', '/api/health']) {
      res = await staging.fetch(new Request(`http://test${path}`))
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    }
    const prod = app('prod')
    res = await prod.fetch(new Request('http://test/robots.txt'))
    const body = await res.text()
    expect(body).toContain('Disallow: /api/')
    expect(body).not.toMatch(/Disallow: \/\n/)
    expect((await prod.fetch(new Request('http://test/'))).headers.get('x-robots-tag')).toBe(null)
  })
})
