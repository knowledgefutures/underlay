import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { arkRoutes, getOrMintShoulder } from '../src/api/ark.js'
import type { AppEnv } from '../src/app.js'
import * as schema from '../src/db/schema.js'
import { buildArkUrl, collectionToArkId, computeNcdaCheckChar } from '../src/lib/ark.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const Link = {
  type: 'object',
  properties: { title: { type: 'string' }, url: { type: 'string' } },
  required: ['title'],
}

/**
 * The ARK routes on the harness's ports, mounted as app.ts would: after the
 * middleware that sets ports, config and principal. `x-test-user` signs in;
 * `x-test-scope` makes it an API key with that scope.
 */
function arkApp(h: Harness) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('ports', h.ports)
    c.set('config', { appUrl: 'https://ul.test', deployment: 'test' })
    const user = c.req.header('x-test-user')
    const scope = (c.req.header('x-test-scope') ?? 'session') as
      | 'session'
      | 'read'
      | 'write'
      | 'admin'
    c.set('principal', user ? { userId: user, scope, collectionIds: null } : null)
    await next()
  })
  app.route('/', arkRoutes())
  return app
}

interface Ctx {
  h: Harness
  user: string
  collectionId: string
  ark: ReturnType<typeof arkApp>
  /** fetch against the ARK routes. */
  req(
    path: string,
    init?: { method?: string; user?: string; scope?: string; json?: unknown },
  ): Promise<Response>
  /** The path after "ark:NAAN/" for this collection, optionally a version and record. */
  name(semver?: string, type?: string, id?: string): string
}

const base = '/api/collections/org/links'
let t: Ctx

async function body(res: Response) {
  return (await res.json()) as Record<string, any>
}

beforeAll(async () => {
  const h = await harness()
  const user = await h.member()
  const c = await h.collection('links')
  await h.ports.db
    .update(schema.collections)
    .set({ public: true })
    .where(eq(schema.collections.id, c.id))

  let res = await h.request(`${base}/push`, {
    method: 'POST',
    user,
    json: { schemas: { Link } },
  })
  const sid = (await body(res)).session_id
  await h.request(`${base}/push/${sid}/records`, {
    method: 'POST',
    user,
    ndjson: [
      { id: 'a', type: 'Link', data: { title: 'A', url: 'https://example.org/a' } },
      { id: 'b', type: 'Link', data: { title: 'B', url: 'https://example.org/b' }, private: true },
      { id: 'evil', type: 'Link', data: { title: 'E', url: 'javascript:alert(1)' } },
      { id: 'none', type: 'Link', data: { title: 'N' } },
    ],
  })
  res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  expect(res.status).toBe(201)

  const ark = arkApp(h)
  const req: Ctx['req'] = async (path, init = {}) => {
    const headers = new Headers()
    if (init.user) headers.set('x-test-user', init.user)
    if (init.scope) headers.set('x-test-scope', init.scope)
    if (init.json !== undefined) headers.set('content-type', 'application/json')
    return ark.fetch(
      new Request(`http://test${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      }),
    )
  }
  t = {
    h,
    user,
    collectionId: c.id,
    ark,
    req,
    name: () => '',
  }

  // Enabling the ARK mints the org's shoulder and the collection's id.
  res = await req(`${base}/ark`, { method: 'PATCH', user, json: { enabled: true } })
  expect(await body(res)).toEqual({ ok: true })
  res = await req(`${base}/ark`, { user })
  const settings = await body(res)
  t.name = (semver, type, id) =>
    new URL(buildArkUrl('12345', settings.shoulder, settings.arkId, semver, type, id)).pathname
      .split('/')
      .slice(2)
      .join('/')
})

const addOrg2 = () =>
  t.h.ports.db
    .insert(schema.organization)
    .values({ id: 'org2', name: 'Two', slug: 'two' })
    .onConflictDoNothing()

const resolve = (path: string, user?: string) =>
  t.req(`/api/ark/resolve?${new URLSearchParams({ path })}`, user ? { user } : {})

describe('collection ARK settings', () => {
  it('reports the minted ARK to members', async () => {
    const res = await t.req(`${base}/ark`, { user: t.user })
    expect(await body(res)).toEqual({
      enabled: true,
      customUrl: null,
      arkUrl: expect.stringMatching(/^https:\/\/underlay\.org\/ark:12345\/ulb\d/),
      shoulder: expect.stringMatching(/^ulb\d$/),
      arkId: collectionToArkId(t.collectionId),
    })
  })

  it('is for members only', async () => {
    expect((await t.req(`${base}/ark`)).status).toBe(401)
    expect((await t.req(`${base}/ark`, { user: 'stranger' })).status).toBe(403)
    // A read-scoped key may read the settings but not change them.
    expect((await t.req(`${base}/ark`, { user: t.user, scope: 'read' })).status).toBe(200)
    const res = await t.req(`${base}/ark`, {
      method: 'PATCH',
      user: t.user,
      scope: 'read',
      json: { enabled: false },
    })
    expect(res.status).toBe(403)
    expect((await t.req(`/api/collections/org/nope/ark`, { user: t.user })).status).toBe(404)
  })

  it('reports no ARK for a collection that has none', async () => {
    await t.h.collection('bare')
    const res = await t.req(`/api/collections/org/bare/ark`, { user: t.user })
    expect(await body(res)).toEqual({
      enabled: false,
      customUrl: null,
      arkUrl: null,
      shoulder: null,
      arkId: null,
    })
    // A private collection stays hidden from non-members.
    expect((await t.req(`/api/collections/org/bare/ark`, { user: 'stranger' })).status).toBe(404)
  })

  it('rejects custom URLs that are not http(s)', async () => {
    for (const customUrl of ['javascript:alert(1)', '//evil.example', 'data:text/html,x']) {
      const res = await t.req(`${base}/ark`, { method: 'PATCH', user: t.user, json: { customUrl } })
      expect(res.status).toBe(422)
    }
    const res = await t.req(`${base}/ark`, { method: 'PATCH', user: t.user, json: { enabled: 1 } })
    expect(res.status).toBe(400)
  })

  it('sets record-type redirect fields', async () => {
    const rt = `${base}/ark/record-types`
    let res = await t.req(rt, { method: 'PUT', user: t.user, json: { recordType: 'X' } })
    expect(res.status).toBe(400)
    res = await t.req(rt, {
      method: 'PUT',
      user: t.user,
      json: { recordType: 'X', redirectUrlField: 'href' },
    })
    expect(await body(res)).toEqual({ ok: true })
    res = await t.req(rt, {
      method: 'PATCH',
      user: t.user,
      json: { recordType: 'Y', redirectUrlField: 'link' },
    })
    expect(res.status).toBe(200)
    expect(await (await t.req(rt, { user: t.user })).json()).toEqual([
      { recordType: 'X', redirectUrlField: 'href' },
      { recordType: 'Y', redirectUrlField: 'link' },
    ])
    // v1's PATCH with null removes; DELETE does the same.
    await t.req(rt, {
      method: 'PATCH',
      user: t.user,
      json: { recordType: 'X', redirectUrlField: null },
    })
    await t.req(`${rt}/Y`, { method: 'DELETE', user: t.user })
    expect(await (await t.req(rt, { user: t.user })).json()).toEqual([])
    expect((await t.req(rt, { user: 'stranger' })).status).toBe(403)
    res = await t.req(rt, {
      method: 'PUT',
      user: 'stranger',
      json: { recordType: 'X', redirectUrlField: 'href' },
    })
    expect(res.status).toBe(403)
  })
})

describe('resolve', () => {
  it('needs an ARK path', async () => {
    expect((await t.req('/api/ark/resolve')).status).toBe(400)
    expect((await resolve('nothing here')).status).toBe(400)
    expect(await body(await resolve('ark:12345/'))).toEqual({ type: 'not_found' })
  })

  it('resolves a collection ARK to its page', async () => {
    const res = await resolve(`ark:12345/${t.name()}`)
    expect(res.status).toBe(200)
    const r = await body(res)
    expect(r).toMatchObject({
      type: 'redirect',
      url: '/org/links',
      metadata: {
        type: 'collection',
        who: 'Org',
        what: 'links',
        where: `https://underlay.org/ark:12345/${t.name()}`,
        naan: '12345',
        collectionName: 'links',
        ownerName: 'Org',
        semver: 'v1.0.0',
        arkUrl: `https://underlay.org/ark:12345/${t.name()}`,
      },
    })
    expect(r.metadata.when).toMatch(/^\d{8}$/)
    // The older "ark:/NAAN/" spelling is the same ARK.
    expect((await body(await resolve(`ark:/12345/${t.name()}`))).url).toBe('/org/links')
  })

  it('resolves a version ARK, showing who pushed only to members', async () => {
    const anon = await body(await resolve(`ark:12345/${t.name('v1.0.0')}`))
    expect(anon).toMatchObject({
      type: 'redirect',
      url: '/org/links/v/1.0.0',
      metadata: { type: 'version', what: 'links v1.0.0', semver: 'v1.0.0' },
    })
    expect(anon.metadata).not.toHaveProperty('pushedBy')
    expect(anon.metadata).not.toHaveProperty('actorId')
    const member = await body(await resolve(`ark:12345/${t.name('v1.0.0')}`, t.user))
    expect(member.metadata).toHaveProperty('pushedBy')
    expect(member.metadata).toHaveProperty('actorId')

    expect((await resolve(`ark:12345/${t.name('v9.0.0')}`)).status).toBe(404)
  })

  it('rejects bad check characters and other orgs’ shoulders', async () => {
    const name = t.name()
    const bad = name.slice(0, -1) + (name.endsWith('b') ? 'c' : 'b')
    expect((await resolve(`ark:12345/${bad}`)).status).toBe(404)

    await addOrg2()
    const other = await getOrMintShoulder(t.h.ports.db, 'org2')
    const arkId = collectionToArkId(t.collectionId)
    const res = await resolve(`ark:12345/${other}${arkId}${computeNcdaCheckChar(arkId)}`)
    expect(res.status).toBe(404)
  })

  it('resolves record ARKs of configured types, by set', async () => {
    // Not configured yet: no record ARKs for the type.
    expect((await resolve(`ark:12345/${t.name(undefined, 'Link', 'a')}`)).status).toBe(404)
    await t.req(`${base}/ark/record-types`, {
      method: 'PUT',
      user: t.user,
      json: { recordType: 'Link', redirectUrlField: 'url' },
    })

    const pub = await body(await resolve(`ark:12345/${t.name(undefined, 'Link', 'a')}`))
    expect(pub).toMatchObject({
      type: 'redirect',
      url: 'https://example.org/a',
      metadata: {
        type: 'record',
        what: 'Link a in links',
        semver: 'v1.0.0',
        recordType: 'Link',
        recordId: 'a',
        schema: Link,
        data: { title: 'A', url: 'https://example.org/a' },
      },
    })
    // Versioned record ARKs resolve at that version.
    const at = await body(await resolve(`ark:12345/${t.name('v1.0.0', 'Link', 'a')}`))
    expect(at.url).toBe('https://example.org/a')

    // A private-set record resolves for members only.
    const priv = `ark:12345/${t.name(undefined, 'Link', 'b')}`
    expect(await body(await resolve(priv))).toEqual({ type: 'not_found' })
    expect(await body(await resolve(priv, 'stranger'))).toEqual({ type: 'not_found' })
    expect((await body(await resolve(priv, t.user))).url).toBe('https://example.org/b')

    // Missing records, and fields that aren't http(s) URLs, don't redirect.
    expect((await resolve(`ark:12345/${t.name(undefined, 'Link', 'zzz')}`)).status).toBe(404)
    for (const id of ['evil', 'none']) {
      const res = await resolve(`ark:12345/${t.name(undefined, 'Link', id)}`)
      expect(res.status).toBe(404)
      expect(await body(res)).toEqual({ type: 'not_found', error: 'No URL found for this record' })
    }
  })

  it('hides private collections from non-members', async () => {
    const db = t.h.ports.db
    const set = (pub: boolean) =>
      db
        .update(schema.collections)
        .set({ public: pub })
        .where(eq(schema.collections.id, t.collectionId))
    await set(false)
    try {
      expect((await resolve(`ark:12345/${t.name()}`)).status).toBe(404)
      expect((await resolve(`ark:12345/${t.name()}`, 'stranger')).status).toBe(404)
      expect((await body(await resolve(`ark:12345/${t.name()}`, t.user))).url).toBe('/org/links')
    } finally {
      await set(true)
    }
  })

  it('follows a custom URL and stops when disabled', async () => {
    const patch = (json: unknown) => t.req(`${base}/ark`, { method: 'PATCH', user: t.user, json })
    await patch({ customUrl: 'https://custom.example/links' })
    try {
      const r = await body(await resolve(`ark:12345/${t.name('v1.0.0')}`))
      expect(r).toMatchObject({
        url: 'https://custom.example/links',
        metadata: { type: 'version', semver: 'v1.0.0' },
      })
      expect(r.metadata).not.toHaveProperty('pushedBy')
      await patch({ enabled: false })
      expect((await resolve(`ark:12345/${t.name()}`)).status).toBe(404)
      expect((await body(await t.req(`${base}/ark`, { user: t.user }))).enabled).toBe(false)
    } finally {
      await patch({ enabled: true, customUrl: '' })
    }
    expect((await body(await resolve(`ark:12345/${t.name()}`))).url).toBe('/org/links')
  })
})

describe('/ark: URLs', () => {
  it('answers the bare NAAN with its policy', async () => {
    for (const p of ['/ark:12345', '/ark:12345/']) {
      const res = await t.req(p)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
      expect(await res.text()).toMatch(
        /^The Underlay assigns identifiers within the ARK domain 12345/,
      )
    }
  })

  it('redirects to the deployment origin', async () => {
    const res = await t.req(`/ark:12345/${t.name()}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://ul.test/org/links')
    const v = await t.req(`/ark:12345/${t.name('v1.0.0')}`)
    expect(v.headers.get('location')).toBe('https://ul.test/org/links/v/1.0.0')
  })

  it('redirects record ARKs to the record URL, by set', async () => {
    const path = `/ark:12345/${t.name(undefined, 'Link', 'a')}`
    expect((await t.req(path)).headers.get('location')).toBe('https://example.org/a')
    const priv = `/ark:12345/${t.name(undefined, 'Link', 'b')}`
    expect((await t.req(priv)).status).toBe(404)
    expect((await t.req(priv, { user: t.user })).headers.get('location')).toBe(
      'https://example.org/b',
    )
  })

  it('answers ?info and ?? with an ERC, and ?json with the metadata', async () => {
    for (const q of ['?info', '??']) {
      const res = await t.req(`/ark:12345/${t.name('v1.0.0')}${q}`)
      expect(res.status).toBe(200)
      const erc = await res.text()
      expect(erc).toMatch(/^erc:\nwho: Org\nwhat: links v1\.0\.0\nwhen: \d{8}\n/)
      expect(erc).toContain(`where: https://underlay.org/ark:12345/${t.name('v1.0.0')}`)
      expect(erc).toContain('where: https://underlay.org/ark:12345/')
    }
    const res = await t.req(`/ark:12345/${t.name()}?json`)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toMatchObject({ type: 'collection', collectionName: 'links' })
  })

  it('is a plain 404 for unknown ARKs', async () => {
    for (const p of [
      '/ark:12345/nope',
      '/ark:12345/ulb9xxxxx',
      `/ark:12345/${t.name()}/Link/%E0%A4%A`,
    ]) {
      const res = await t.req(p)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('ARK not found')
    }
  })
})

describe('organization NAAN', () => {
  it('is set by org owners and admins, and used in ARK URLs', async () => {
    const naanPath = '/api/accounts/org/ark'
    const patch = (json: unknown, user?: string, scope?: string) =>
      t.req(naanPath, {
        method: 'PATCH',
        json,
        ...(user ? { user } : {}),
        ...(scope ? { scope } : {}),
      })
    expect((await patch({ naan: '99999' })).status).toBe(401)
    expect((await patch({ naan: '99999' }, 'stranger')).status).toBe(403)
    expect((await patch({ naan: '99999' }, t.user, 'read')).status).toBe(403)
    // An owner's write key acts as a member: only a session or an admin key may.
    expect((await patch({ naan: '99999' }, t.user, 'write')).status).toBe(403)
    expect((await patch({ naan: 'abc' }, t.user)).status).toBe(400)
    expect((await patch({ naan: '12345' }, t.user)).status).toBe(409)
    expect(
      (
        await t.req('/api/accounts/nope/ark', {
          method: 'PATCH',
          user: t.user,
          json: { naan: null },
        })
      ).status,
    ).toBe(404)

    expect((await patch({ naan: '99999' }, t.user, 'admin')).status).toBe(200)
    expect((await patch({ naan: '99999' }, t.user)).status).toBe(200)
    try {
      const settings = await body(await t.req(`${base}/ark`, { user: t.user }))
      expect(settings.arkUrl).toMatch(/^https:\/\/underlay\.org\/ark:99999\//)
      // Resolution answers with the org's NAAN, whichever the ARK was written with.
      const r = await body(await resolve(`ark:12345/${t.name()}`))
      expect(r.metadata.naan).toBe('99999')
      expect(r.metadata.arkUrl).toBe(`https://underlay.org/ark:99999/${t.name()}`)
      // Another org can't claim it.
      await addOrg2()
      await t.h.ports.db
        .insert(schema.member)
        .values({ organizationId: 'org2', userId: t.user, role: 'admin' })
      expect(
        (
          await t.req('/api/accounts/two/ark', {
            method: 'PATCH',
            user: t.user,
            json: { naan: '99999' },
          })
        ).status,
      ).toBe(409)
    } finally {
      await patch({ naan: null }, t.user)
    }
  })
})
