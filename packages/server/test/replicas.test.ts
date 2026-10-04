import { describe, expect, it } from 'vitest'

import { readsAnyReplica } from '../src/db/replicas.js'

const req = (path: string, init: RequestInit = {}) => new Request(`https://x.test${path}`, init)

describe('read replicas', () => {
  it('serve anonymous reads only', () => {
    expect(readsAnyReplica(req('/umass/holdings'))).toBe(true)
    expect(readsAnyReplica(req('/api/collections/a/b/versions', { method: 'HEAD' }))).toBe(true)
    expect(readsAnyReplica(req('/api/collections', { method: 'POST' }))).toBe(false)
    expect(readsAnyReplica(req('/x', { headers: { authorization: 'Bearer ul_x' } }))).toBe(false)
    expect(readsAnyReplica(req('/api/collections/a/b/files/h?token=ul_x'))).toBe(false)
    expect(
      readsAnyReplica(
        req('/dashboard', { headers: { cookie: '__Secure-better-auth.session_token=s' } }),
      ),
    ).toBe(false)
    expect(readsAnyReplica(req('/x', { headers: { cookie: 'theme=dark' } }))).toBe(true)
    expect(readsAnyReplica(req('/api/auth/oauth2/callback/kf-auth?code=c'))).toBe(false)
    expect(readsAnyReplica(req('/login'))).toBe(false)
  })
})
