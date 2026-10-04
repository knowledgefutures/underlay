import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { createKf } from '../src/auth/kf.js'
import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('KF Auth client', () => {
  it('refreshes an expired token, reads the role, and finds KF orgs', async () => {
    const h = await harness()
    const { db } = h.ports
    await db.insert(schema.user).values({ id: 'u1', name: 'Ada', email: 'ada@example.org' })
    await db.insert(schema.account).values({
      id: 'a1',
      accountId: 'kf-user-old',
      providerId: 'kf-auth',
      userId: 'u1',
      accessToken: 'stale',
      refreshToken: 'r1',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    })
    const calls: string[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auth = new Headers(init?.headers).get('authorization')
      calls.push(`${init?.method ?? 'GET'} ${url.replace('http://kf', '')} ${auth ?? ''}`.trim())
      if (url.endsWith('/oauth2/token')) {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('refresh_token')).toBe('r1')
        return json({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 })
      }
      if (url.endsWith('/oauth2/userinfo')) {
        return auth === 'Bearer fresh'
          ? json({ name: 'Ada L', 'https://knowledgefutures.org/role': 'admin' })
          : json({}, 401)
      }
      // The stored KF id finds no orgs; the email search finds the right user.
      if (url.endsWith('/internal/users/kf-user-old/orgs')) return json({ orgs: [] })
      if (url.includes('/internal/users/search'))
        return json({ users: [{ id: 'x' }, { id: 'k2' }] })
      if (url.endsWith('/internal/users/x')) return json({ email: 'someone@else.org' })
      if (url.endsWith('/internal/users/k2')) return json({ email: 'ADA@example.org' })
      if (url.endsWith('/internal/users/k2/orgs')) {
        return json([
          { id: 'kf-shared', name: 'S', slug: 's', type: 'shared', role: 'member' },
          { id: 'kf-own', name: 'A', slug: 'a', type: 'personal', role: 'owner' },
        ])
      }
      return json({}, 404)
    }) as typeof fetch

    const kf = createKf(
      db,
      { internalUrl: 'http://kf', clientId: 'c', clientSecret: 's', internalApiKey: 'ik' },
      fetcher,
    )
    expect(await kf.profile('u1')).toEqual({ name: 'Ada L', image: null, role: 'admin' })
    const [acct] = await db.select().from(schema.account).where(eq(schema.account.id, 'a1'))
    expect(acct).toMatchObject({ accessToken: 'fresh', refreshToken: 'r2' })

    // Cached for the shell; role() reads fresh, with the stored (now valid) token.
    calls.length = 0
    await kf.profile('u1')
    expect(calls).toEqual([])
    expect(await kf.role('u1')).toBe('admin')
    expect(calls).toEqual(['GET /api/auth/oauth2/userinfo Bearer fresh'])

    expect(await kf.defaultOrgId('u1')).toBe('kf-own')
    expect(await kf.entitled('u1', 'kf-shared')).toBe(true)
    expect(await kf.entitled('u1', 'kf-else')).toBe(false)
    expect(
      calls.filter((c) => c.includes('/internal/')).every((c) => c.endsWith('Bearer ik')),
    ).toBe(true)

    expect(kf.isInternalCall('Bearer ik')).toBe(true)
    expect(kf.isInternalCall('Bearer i')).toBe(false)
    expect(kf.isInternalCall(undefined)).toBe(false)
  })

  it('without the internal key, has no orgs and accepts no internal calls', async () => {
    const h = await harness()
    const kf = createKf(
      h.ports.db,
      { internalUrl: 'http://kf', clientId: 'c', clientSecret: 's' },
      (() => {
        throw new Error('no network')
      }) as typeof fetch,
    )
    expect(await kf.orgs('u1')).toEqual([])
    expect(await kf.profile('u1')).toBeNull()
    expect(kf.isInternalCall('Bearer ')).toBe(false)
  })
})
