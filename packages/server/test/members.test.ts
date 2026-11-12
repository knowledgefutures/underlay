import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

describe("an organization's members", () => {
  it('are hidden from outsiders until each chooses to be listed, and then by name only', async () => {
    const h = await harness()
    const owner = await h.member('u1')
    await h.ports.db.insert(schema.user).values([
      { id: 'u2', name: 'Alex', email: 'u2@example.org' },
      { id: 'u3', name: 'Stranger', email: 'u3@example.org' },
    ])
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'org1', userId: 'u2', role: 'member' })
    const list = async (user?: string) =>
      (await (await h.request('/api/accounts/org/members', user ? { user } : {})).json()) as Record<
        string,
        unknown
      >[]
    const show = (user: string, json: unknown) =>
      h.request('/api/accounts/org/members/me', { method: 'PUT', user, json })

    // No one has chosen: outsiders see no one; members see everyone, with roles.
    expect(await list()).toEqual([])
    expect(await list('u3')).toEqual([])
    expect(await list(owner)).toEqual(
      expect.arrayContaining([
        { role: 'owner', displayName: 'u1', public: false, you: true },
        { role: 'member', displayName: 'Alex', public: false, you: false },
      ]),
    )

    // One member lists themselves: outsiders see their name, never a role.
    expect((await show('u2', { public: true })).status).toBe(200)
    expect(await list()).toEqual([{ displayName: 'Alex' }])
    expect(await list('u3')).toEqual([{ displayName: 'Alex' }])
    expect(await list('u2')).toContainEqual({
      role: 'member',
      displayName: 'Alex',
      public: true,
      you: true,
    })

    // Only a member changes only their own; the body is a boolean.
    expect((await show('u3', { public: true })).status).toBe(403)
    expect((await h.request('/api/accounts/org/members/me', { method: 'PUT' })).status).toBe(401)
    expect((await show('u2', { public: 'yes' })).status).toBe(400)
    expect((await show('u2', { public: false })).status).toBe(200)
    expect(await list()).toEqual([])
    expect((await h.request('/api/accounts/nope/members')).status).toBe(404)
  })
})
