import { describe, expect, it, vi } from 'vitest'

import {
  decideCollectionWrite,
  decideOwnSession,
  keyScopeAllows,
  NOT_SCOPED_MESSAGE,
  roleMeets,
  type SessionAccessRow,
  sessionScopeDenial,
} from './collection-access.js'

describe('keyScopeAllows', () => {
  it('passes callers without a scoped key', () => {
    expect(keyScopeAllows(undefined, 'c1')).toBe(true)
  })

  it('passes a key scoped to the collection and refuses one scoped elsewhere', () => {
    expect(keyScopeAllows(['c1', 'c2'], 'c2')).toBe(true)
    expect(keyScopeAllows(['c1'], 'c2')).toBe(false)
  })
})

describe('roleMeets', () => {
  it('admits any member at the member level', () => {
    expect(roleMeets('member', 'member')).toBe(true)
    expect(roleMeets('owner', 'member')).toBe(true)
    expect(roleMeets(null, 'member')).toBe(false)
  })

  it('admits only owner and admin at the admin level', () => {
    expect(roleMeets('owner', 'admin')).toBe(true)
    expect(roleMeets('admin', 'admin')).toBe(true)
    expect(roleMeets('member', 'admin')).toBe(false)
    expect(roleMeets(null, 'admin')).toBe(false)
  })
})

describe('decideCollectionWrite', () => {
  const collection = { id: 'c1' }
  const role = (r: string | null) => vi.fn(async () => r)

  it('404s a collection that did not resolve, with the configured message', async () => {
    const getRole = role('owner')
    expect(await decideCollectionWrite(null, { scopedCollectionIds: undefined, getRole })).toEqual({
      denial: { status: 404, error: 'Collection not found' },
    })
    expect(
      await decideCollectionWrite(
        null,
        { scopedCollectionIds: undefined, getRole },
        { notFoundMessage: 'Not found' },
      ),
    ).toEqual({ denial: { status: 404, error: 'Not found' } })
    expect(getRole).not.toHaveBeenCalled()
  })

  it('returns the role for a member with an unscoped key', async () => {
    expect(
      await decideCollectionWrite(collection, {
        scopedCollectionIds: undefined,
        getRole: role('member'),
      }),
    ).toEqual({ role: 'member' })
  })

  it('refuses non-members, and members below minRole', async () => {
    const forbidden = { denial: { status: 403, error: 'Forbidden' } }
    expect(
      await decideCollectionWrite(collection, {
        scopedCollectionIds: undefined,
        getRole: role(null),
      }),
    ).toEqual(forbidden)
    expect(
      await decideCollectionWrite(
        collection,
        { scopedCollectionIds: undefined, getRole: role('member') },
        { minRole: 'admin' },
      ),
    ).toEqual(forbidden)
  })

  it('checks role before scope by default', async () => {
    // A non-member holding a key scoped elsewhere hears "Forbidden", not the scope message.
    expect(
      await decideCollectionWrite(collection, { scopedCollectionIds: ['c2'], getRole: role(null) }),
    ).toEqual({ denial: { status: 403, error: 'Forbidden' } })
    expect(
      await decideCollectionWrite(collection, {
        scopedCollectionIds: ['c2'],
        getRole: role('owner'),
      }),
    ).toEqual({ denial: { status: 403, error: NOT_SCOPED_MESSAGE } })
  })

  it('checks scope first, without a role lookup, when asked to', async () => {
    const getRole = role(null)
    expect(
      await decideCollectionWrite(
        collection,
        { scopedCollectionIds: ['c2'], getRole },
        { scopeFirst: true },
      ),
    ).toEqual({ denial: { status: 403, error: NOT_SCOPED_MESSAGE } })
    expect(getRole).not.toHaveBeenCalled()
  })

  it('uses the configured scope message (ARK settings say "Forbidden")', async () => {
    expect(
      await decideCollectionWrite(
        collection,
        { scopedCollectionIds: ['c2'], getRole: role('owner') },
        { scopeFirst: true, scopeMessage: 'Forbidden' },
      ),
    ).toEqual({ denial: { status: 403, error: 'Forbidden' } })
  })

  it('passes a key scoped to this collection', async () => {
    expect(
      await decideCollectionWrite(
        collection,
        { scopedCollectionIds: ['c1'], getRole: role('admin') },
        { minRole: 'admin' },
      ),
    ).toEqual({ role: 'admin' })
  })
})

describe('decideOwnSession', () => {
  const now = new Date('2026-10-01T12:00:00Z')
  const session: SessionAccessRow = {
    userId: 'u1',
    collectionId: 'c1',
    status: 'open',
    expiresAt: new Date('2026-10-01T12:05:00Z'),
    ownerSlug: 'acme',
    collectionSlug: 'books',
  }
  const request = {
    owner: 'acme',
    slug: 'books',
    userId: 'u1',
    now,
  }

  it('passes the caller’s own open session under its own collection', () => {
    expect(decideOwnSession(session, request, { requireOpen: true })).toBeNull()
    expect(decideOwnSession(session, request)).toBeNull()
  })

  it('404s a missing session with the message for the mode', () => {
    expect(decideOwnSession(undefined, request)).toEqual({
      denial: { status: 404, error: 'Session not found' },
      expire: false,
    })
    expect(decideOwnSession(undefined, request, { requireOpen: true })).toEqual({
      denial: { status: 404, error: 'Session expired or not found' },
      expire: false,
    })
  })

  it('treats a session reached through another collection as missing, with no side effects', () => {
    const stale = { ...session, expiresAt: new Date('2026-10-01T11:00:00Z') }
    for (const other of [
      { ...request, slug: 'films' },
      { ...request, owner: 'other-org' },
    ]) {
      expect(decideOwnSession(session, other)).toEqual({
        denial: { status: 404, error: 'Session not found' },
        expire: false,
      })
      expect(decideOwnSession(stale, other, { requireOpen: true, expireAnyStatus: true })).toEqual({
        denial: { status: 404, error: 'Session expired or not found' },
        expire: false,
      })
    }
  })

  it('refuses a stale or closed session when it must be open, expiring only open ones', () => {
    const stale = { ...session, expiresAt: new Date('2026-10-01T11:00:00Z') }
    const committed = { ...session, status: 'committed' }
    const notFound = { status: 404, error: 'Session expired or not found' }
    expect(decideOwnSession(stale, request, { requireOpen: true })).toEqual({
      denial: notFound,
      expire: true,
    })
    expect(decideOwnSession(committed, request, { requireOpen: true })).toEqual({
      denial: notFound,
      expire: false,
    })
  })

  it('expires a closed session too with expireAnyStatus (the records route)', () => {
    const committed = { ...session, status: 'committed' }
    expect(
      decideOwnSession(committed, request, { requireOpen: true, expireAnyStatus: true }),
    ).toEqual({ denial: { status: 404, error: 'Session expired or not found' }, expire: true })
  })

  it('lets GET and DELETE reach a session that is no longer open', () => {
    expect(decideOwnSession({ ...session, status: 'committed' }, request)).toBeNull()
  })

  it('refuses another user’s session', () => {
    expect(decideOwnSession(session, { ...request, userId: 'u2' })).toEqual({
      denial: { status: 403, error: 'Not authorized' },
      expire: false,
    })
    expect(decideOwnSession(session, { ...request, userId: undefined })).toEqual({
      denial: { status: 403, error: 'Not authorized' },
      expire: false,
    })
  })
})

describe('sessionScopeDenial', () => {
  it('refuses a key scoped to other collections', () => {
    expect(sessionScopeDenial({ collectionId: 'c1' }, ['c2'])).toEqual({
      status: 403,
      error: NOT_SCOPED_MESSAGE,
    })
    expect(sessionScopeDenial({ collectionId: 'c1' }, ['c1'])).toBeNull()
    expect(sessionScopeDenial({ collectionId: 'c1' }, undefined)).toBeNull()
  })
})
