/**
 * An app over the test harness's ports that knows sessions, API keys and KF
 * Auth (a fake), for routes that depend on who the caller is.
 */
import type { Principal } from '../src/api/access.js'
import { createApp } from '../src/app.js'
import type { Kf } from '../src/auth/kf.js'
import * as schema from '../src/db/schema.js'
import { harness } from './harness.js'

/** A KF Auth stand-in: user u1 belongs to KF org kf-1 and is a steward. */
export const fakeKf: Kf = {
  profile: async (userId) =>
    userId === 'u1' ? { name: 'Ada KF', image: null, role: 'admin' } : null,
  role: async (userId) => (userId === 'u1' ? 'admin' : null),
  orgs: async (userId) =>
    userId === 'u1'
      ? [{ id: 'kf-1', name: 'KF One', slug: 'kf-one', type: 'shared', role: 'owner' }]
      : [],
  entitled: async (userId, id) => userId === 'u1' && id === 'kf-1',
  defaultOrgId: async () => null,
  isInternalCall: (h) => h === 'Bearer internal-key',
}

/**
 * The harness's ports behind an app that knows sessions and keys:
 * `x-test-user` signs in (session `s-<user>`), `x-test-key: read|scoped|org`
 * makes the caller an API key of that kind.
 */
export async function setup() {
  const h = await harness()
  const app = createApp(() => ({
    ports: h.ports,
    config: { appUrl: 'http://test', deployment: 'test' },
    kf: fakeKf,
    authenticate: async (req): Promise<Principal | null> => {
      const user = req.headers.get('x-test-user')
      if (!user) return null
      const key = req.headers.get('x-test-key')
      if (key === 'read') return { userId: user, scope: 'read', collectionIds: null }
      if (key === 'scoped') return { userId: user, scope: 'write', collectionIds: ['x'] }
      if (key === 'org')
        return { userId: 'org1', scope: 'write', collectionIds: null, orgId: 'org1' }
      return { userId: user, scope: 'session', collectionIds: null, sessionId: `s-${user}` }
    },
  }))
  const call = (
    path: string,
    init: {
      method?: string
      user?: string
      key?: string
      json?: unknown
      authorization?: string
    } = {},
  ) => {
    const headers = new Headers()
    if (init.user) headers.set('x-test-user', init.user)
    if (init.key) headers.set('x-test-key', init.key)
    if (init.authorization) headers.set('authorization', init.authorization)
    if (init.json !== undefined) headers.set('content-type', 'application/json')
    return app.fetch(
      new Request(`http://test${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      }),
    )
  }
  const { db } = h.ports
  /** A user with a personal org `<id>` (and membership of `org` as owner via h.member). */
  const user = async (id: string) => {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.org` })
    await db
      .insert(schema.organization)
      .values({ id: `p-${id}`, name: id, slug: id, isDefault: true })
    await db.insert(schema.member).values({ organizationId: `p-${id}`, userId: id, role: 'owner' })
    return id
  }
  return { h, call, db, user }
}
