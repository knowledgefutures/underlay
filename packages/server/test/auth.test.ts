import { afterAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { authenticator, createAuth } from '../src/auth/auth.js'
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
    expect(
      (await call('/api/collections/org/authors/push', 'ul_bogus', { schemas: { Author } })).status,
    ).toBe(404)
    expect(
      (await call('/api/collections/org/authors/push', scoped.key, { schemas: { Author } })).status,
    ).toBe(200)
    // A key limited to one collection is a stranger everywhere else.
    expect(
      (await call('/api/collections/org/other/push', scoped.key, { schemas: { Author } })).status,
    ).toBe(404)

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
  })
})
