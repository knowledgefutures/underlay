import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { authenticator, createAuth, keyConfig } from '../src/auth/auth.js'
import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } } }

describe('better-auth on SQLite', () => {
  it('authenticates API keys with their scope and collection limits', async () => {
    const h = await harness()
    const user = await h.member('u1')
    const c = await h.collection('authors')
    await h.collection('other')
    const auth = createAuth(
      h.ports.db,
      {
        appUrl: 'http://test',
        secret: 'test-secret-test-secret-test-secret',
        oidc: {
          issuerUrl: 'http://kf',
          internalUrl: 'http://kf',
          clientId: 'x',
          clientSecret: 'y',
        },
      },
      () => {},
    )
    const app = createApp(() => ({
      ports: h.ports,
      config: { appUrl: 'http://test', deployment: 'test' },
      authenticate: authenticator(() => auth),
      authHandler: (req) => auth.handler(req),
    }))
    const call = (path: string, key: string, body: unknown) =>
      app.fetch(
        new Request(`http://test${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )

    const write = await auth.api.createApiKey({
      body: { userId: user, metadata: { scope: 'write' } },
    })
    const read = await auth.api.createApiKey({ body: { userId: user } })
    const scoped = await auth.api.createApiKey({
      body: { userId: user, metadata: { scope: 'write', collectionIds: [c.id] } },
    })
    expect(write.key).toMatch(/^ul_/)

    expect(
      (await call('/api/collections/org/authors/push', write.key, { schemas: { Author } })).status,
    ).toBe(200)
    expect(
      (await call('/api/collections/org/authors/push', read.key, { schemas: { Author } })).status,
    ).toBe(403)
    // The scheme is case-insensitive.
    const lower = await app.fetch(
      new Request('http://test/api/collections/org/authors/push', {
        method: 'POST',
        headers: { authorization: `bearer  ${write.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ schemas: { Author } }),
      }),
    )
    expect(lower.status).toBe(200)
    expect(
      (await call('/api/collections/org/authors/push', 'ul_bogus', { schemas: { Author } })).status,
    ).toBe(401)
    expect(
      (await call('/api/collections/org/authors/push', scoped.key, { schemas: { Author } })).status,
    ).toBe(200)
    // A key limited to one collection is a stranger everywhere else.
    expect(
      (await call('/api/collections/org/other/push', scoped.key, { schemas: { Author } })).status,
    ).toBe(404)

    // A key acts with at most its scope: write keys as members, admin keys with the role,
    // unless confined to collections: such a key writes to them but never manages them.
    const admin = await auth.api.createApiKey({
      body: { userId: user, metadata: { scope: 'admin' } },
    })
    const scopedAdmin = await auth.api.createApiKey({
      body: { userId: user, metadata: { scope: 'admin', collectionIds: [c.id] } },
    })
    const send = (method: string, path: string, key: string, body?: unknown) =>
      app.fetch(
        new Request(`http://test${path}`, {
          method,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      )
    for (const k of [write.key, scoped.key, scopedAdmin.key]) {
      expect(
        (await send('PATCH', '/api/collections/org/authors', k, { public: true })).status,
      ).toBe(403)
      expect((await send('DELETE', '/api/collections/org/authors', k)).status).toBe(403)
    }
    expect(
      (await send('PATCH', '/api/collections/org/authors', admin.key, { public: true })).status,
    ).toBe(200)

    // Keys are checked against their row; last_request is written once, not per call.
    const rows = async () =>
      (await h.ports.db.select().from(schema.apikey)).find(
        (k) => k.start === write.key.slice(0, 6),
      )!
    const first = (await rows()).lastRequest
    expect(first).not.toBeNull()
    await call('/api/collections/org/authors/push', write.key, { schemas: { Author } })
    expect((await rows()).lastRequest).toEqual(first)
    // A disabled key stops working once the isolate's copy of its row expires.
    keyConfig.cacheMs = 0
    await h.ports.db
      .update(schema.apikey)
      .set({ enabled: false })
      .where(eq(schema.apikey.id, (await rows()).id))
    expect(
      (await call('/api/collections/org/authors/push', write.key, { schemas: { Author } })).status,
    ).toBe(401)
    keyConfig.cacheMs = 30_000

    // The auth routes are mounted.
    const res = await app.fetch(new Request('http://test/api/auth/get-session'))
    expect(res.status).toBeLessThan(500)
  })

  it('gives every new user a personal organization', async () => {
    const h = await harness()
    const auth = createAuth(
      h.ports.db,
      {
        appUrl: 'http://test',
        secret: 'test-secret-test-secret-test-secret',
        oidc: {
          issuerUrl: 'http://kf',
          internalUrl: 'http://kf',
          clientId: 'x',
          clientSecret: 'y',
        },
      },
      () => {},
    )
    const ctx = await auth.$context
    await ctx.internalAdapter.createUser({
      name: 'Ada',
      email: 'ada@example.org',
      emailVerified: true,
    })
    const orgs = await h.ports.db.select().from(schema.organization)
    expect(orgs.map((o) => [o.slug, o.isDefault])).toEqual([['ada', true]])
    const members = await h.ports.db.select().from(schema.member)
    expect(members[0]).toMatchObject({ organizationId: orgs[0]!.id, role: 'owner' })
  })

  it('sends /login to KF Auth, and renders the page only to show an error', async () => {
    const h = await harness()
    const auth = createAuth(
      h.ports.db,
      {
        appUrl: 'http://test',
        secret: 'test-secret-test-secret-test-secret',
        oidc: {
          issuerUrl: 'http://kf',
          internalUrl: 'http://kf',
          clientId: 'x',
          clientSecret: 'y',
        },
      },
      () => {},
    )
    const app = createApp(() => ({
      ports: h.ports,
      config: { appUrl: 'http://test', deployment: 'test' },
      authenticate: authenticator(() => auth),
      authHandler: (req) => auth.handler(req),
      renderPage: async () => new Response('page'),
    }))

    const res = await app.fetch(new Request('http://test/login'))
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('http://kf/api/auth/oauth2/authorize')
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://test/api/auth/oauth2/callback/kf-auth',
    )
    // The state cookie must reach the browser, or the callback can't be checked.
    expect(res.headers.getSetCookie().some((c) => c.includes('better-auth.state'))).toBe(true)

    const failed = await app.fetch(new Request('http://test/login?error=auth_failed'))
    expect(await failed.text()).toBe('page')

    // return_to survives sign-in when it is a path on this site, and only then.
    const stateOf = async (q: string) => {
      await h.ports.db.delete(schema.verification)
      const r = await app.fetch(new Request(`http://test/login?return_to=${encodeURIComponent(q)}`))
      expect(r.status).toBe(302)
      const [v] = await h.ports.db.select().from(schema.verification)
      return JSON.parse(v!.value) as { callbackURL: string }
    }
    expect((await stateOf('/invitations/accept?token=t')).callbackURL).toBe(
      '/invitations/accept?token=t',
    )
    expect((await stateOf('//evil.example/x')).callbackURL).toBe('/dashboard')
    expect((await stateOf('/\\evil.example')).callbackURL).toBe('/dashboard')
    expect((await stateOf('https://evil.example/')).callbackURL).toBe('/dashboard')
  })
})

describe('KF org links on organizations', () => {
  it('keeps a kfOrgId the creator belongs to, and replaces any other', async () => {
    const h = await harness()
    const kf = {
      profile: async () => null,
      role: async () => null,
      orgs: async () => [],
      entitled: async (_u: string, id: string) => id === 'kf-mine',
      defaultOrgId: async () => 'kf-default',
      isInternalCall: () => false,
    }
    const auth = createAuth(
      h.ports.db,
      {
        appUrl: 'http://test',
        secret: 'test-secret-test-secret-test-secret',
        oidc: {
          issuerUrl: 'http://kf',
          internalUrl: 'http://kf',
          clientId: 'x',
          clientSecret: 'y',
        },
      },
      () => {},
      kf,
    )
    const ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser({
      name: 'Ada',
      email: 'ada@example.org',
      emailVerified: true,
    })
    const create = (slug: string, kfOrgId: string) =>
      auth.api.createOrganization({ body: { name: slug, slug, userId: user.id, kfOrgId } as never })
    await create('mine', 'kf-mine')
    await create('theirs', 'kf-theirs')
    const orgs = await h.ports.db.select().from(schema.organization)
    const link = (slug: string) => orgs.find((o) => o.slug === slug)?.kfOrgId
    expect(link('mine')).toBe('kf-mine')
    expect(link('theirs')).toBe('kf-default')

    // Logos come from the upload only: better-auth's fields are any URL.
    await auth.api.createOrganization({
      body: {
        name: 'logo',
        slug: 'logo',
        userId: user.id,
        logo: 'https://evil.example/x.png',
      } as never,
    })
    const [logo] = await h.ports.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, 'logo'))
    expect(logo!.logo).toBeNull()
    expect(logo!.avatarUrl).toBeNull()
    await auth.api.createOrganization({
      body: {
        name: 'av',
        slug: 'av',
        userId: user.id,
        avatarUrl: 'https://evil.example/x.png',
      } as never,
    })
    const [av] = await h.ports.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, 'av'))
    expect(av!.avatarUrl).toBeNull()

    // better-auth's org update and delete are closed; the account routes apply the rules.
    const app = createApp(() => ({
      ports: h.ports,
      config: { appUrl: 'http://test', deployment: 'test' },
      authenticate: authenticator(() => auth),
      authHandler: (req) => auth.handler(req),
    }))
    for (const route of ['update', 'delete']) {
      const res = await app.fetch(
        new Request(`http://test/api/auth/organization/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId: 'org1' }),
        }),
      )
      expect(res.status).toBe(404)
    }
  })
})

describe('agent links', () => {
  it('serve push instructions for an agent key, and a 404 page for anything else', async () => {
    const h = await harness()
    const user = await h.member('u1')
    const c = await h.collection('notes')
    const other = await h.collection('other')
    await h.ports.db
      .update(schema.collections)
      .set({ name: '<script>alert("x")</script>' })
      .where(eq(schema.collections.id, c.id))
    const auth = createAuth(
      h.ports.db,
      {
        appUrl: 'http://test',
        secret: 'test-secret-test-secret-test-secret',
        oidc: {
          issuerUrl: 'http://kf',
          internalUrl: 'http://kf',
          clientId: 'x',
          clientSecret: 'y',
        },
      },
      () => {},
    )
    const app = createApp(() => ({
      ports: h.ports,
      config: { appUrl: 'http://test', deployment: 'test' },
      authenticate: authenticator(() => auth),
      renderPage: async () => new Response('page'),
    }))
    const key = (metadata: Record<string, unknown>, userId = user) =>
      auth.api.createApiKey({ body: { userId, metadata } })
    // As the share panel makes them (web's share-panel.tsx).
    const agent = (await key({ scope: 'write', collectionIds: [c.id], agentShare: true })).key
    const page = (token: string) => app.fetch(new Request(`https://ul.example/agent/${token}`))

    let res = await page(agent)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    let html = await res.text()
    expect(html).toContain('https://ul.example/api/collections/org/notes/push')
    expect(html).toContain('https://ul.example/llms.txt')
    expect(html).toContain('no types yet')
    expect(html).toContain('&quot;base&quot;: null')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')

    // The page's steps work with the page's key.
    const call = (method: string, path: string, body?: string, type = 'application/json') =>
      app.fetch(
        new Request(`http://test/api/collections/org/notes${path}`, {
          method,
          headers: { authorization: `Bearer ${agent}`, 'content-type': type },
          ...(body !== undefined ? { body } : {}),
        }),
      )
    const update = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        key_points: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' },
        timestamp: { type: 'string' },
      },
      required: ['title', 'summary'],
      additionalProperties: false,
    }
    const open = await call('POST', '/push', JSON.stringify({ base: null, schemas: { update } }))
    expect(open.status).toBe(200)
    const sid = ((await open.json()) as { session_id: string }).session_id
    const line = { id: 'u-1', type: 'update', data: { title: 'T', summary: 'S' } }
    expect(
      (await call('POST', `/push/${sid}/records`, JSON.stringify(line), 'application/x-ndjson'))
        .status,
    ).toBe(200)
    expect((await call('POST', `/push/${sid}/commit`)).status).toBe(201)
    html = await (await page(agent)).text()
    expect(html).toContain('<code>v1.0.0</code>')
    expect(html).toContain('Type <code>update</code>')
    expect(html).toContain('&quot;u-1&quot;')
    expect(html).not.toContain('no types yet')

    // Not an agent key, not confined to one collection, read-only, expired, or held by
    // someone who can't write there: the same 404 page.
    await h.ports.db.insert(schema.user).values({ id: 'u2', name: 'u2', email: 'u2@example.org' })
    const expired = await key({ scope: 'write', collectionIds: [c.id], agentShare: true })
    await h.ports.db
      .update(schema.apikey)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apikey.id, expired.id))
    const refused = [
      (await key({ scope: 'write', collectionIds: [c.id] })).key,
      (await key({ scope: 'write', collectionIds: [c.id, other.id], agentShare: true })).key,
      (await key({ scope: 'read', collectionIds: [c.id], agentShare: true })).key,
      (await key({ scope: 'write', collectionIds: [c.id], agentShare: true }, 'u2')).key,
      expired.key,
      'ul_doesnotexistatall',
      'ul_%3Cbad%3E',
    ]
    for (const token of refused) {
      res = await page(token)
      expect(res.status, token).toBe(404)
      expect(await res.text()).toContain('Invalid or expired agent link')
    }
    // A path that isn't a key is a UI page (an org named "agent" keeps its collections).
    expect(await (await page('notes')).text()).toBe('page')
  })
})
