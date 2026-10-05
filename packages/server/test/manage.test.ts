import { readHead, verifyLog } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'
import { setup } from './kf-app.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } } }

async function json(res: Response) {
  return (await res.json()) as any
}

describe('collection management', () => {
  it('creates, updates, edits metadata, forks, transfers and deletes', async () => {
    const h = await harness()
    const user = await h.member()
    let res = await h.request('/api/accounts/org/collections', {
      method: 'POST',
      user,
      json: { slug: 'new-one', name: 'New One', public: true },
    })
    expect(res.status).toBe(201)
    expect(
      (
        await h.request('/api/accounts/org/collections', {
          method: 'POST',
          user,
          json: { slug: 'new-one' },
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await h.request('/api/accounts/org/collections', {
          method: 'POST',
          user,
          json: { slug: 'API' },
        })
      ).status,
    ).toBe(422)
    expect(
      (await h.request('/api/accounts/org/collections', { method: 'POST', json: { slug: 'x' } }))
        .status,
    ).toBe(401)

    const base = '/api/collections/org/new-one'
    const sid = (
      await json(
        await h.request(`${base}/push`, {
          method: 'POST',
          user,
          json: { schemas: { Author }, metadata: { title: 'T' } },
        }),
      )
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [
        { id: 'a', type: 'Author', data: { name: 'A' } },
        { id: 'b', type: 'Author', data: { name: 'B' }, private: true },
      ],
    })
    expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      201,
    )

    // Metadata and fork bodies follow the input rules, as pushes do.
    for (const [path, body] of [
      [`${base}/metadata`, '{"description":"a","description":"b"}'],
      [`${base}/metadata`, '{"count":9007199254740993}'],
      [`${base}/fork`, '{"targetOrg":"org","targetOrg":"org","slug":"dup"}'],
    ] as const) {
      const bad = await h.request(path, {
        method: 'POST',
        user,
        body,
        headers: { 'content-type': 'application/json' },
      })
      expect(bad.status).toBe(400)
      expect((await json(bad)).error).toMatch(/duplicate_key|unsafe_integer/)
    }

    // Metadata edit: a patch version reusing every set.
    res = await h.request(`${base}/metadata`, {
      method: 'POST',
      user,
      json: { description: 'Edited' },
    })
    expect(res.status).toBe(201)
    expect((await json(res)).semver).toBe('v1.0.1')
    const detail = await json(await h.request(base))
    expect(detail.latestVersion.metadata).toEqual({ title: 'T', description: 'Edited' })
    expect(detail.description).toBe('Edited')

    // null clears a field (the settings page sends every field, empty ones as null).
    res = await h.request(`${base}/metadata`, {
      method: 'POST',
      user,
      json: { title: null, readme: null, description: 'Edited' },
    })
    expect(res.status).toBe(201)
    expect((await json(res)).semver).toBe('v1.0.2')
    expect((await json(await h.request(base))).latestVersion.metadata).toEqual({
      description: 'Edited',
    })
    res = await h.request(`${base}/metadata`, {
      method: 'POST',
      user,
      json: { title: null, description: 'Edited' },
    })
    expect(await json(res)).toEqual({ semver: 'v1.0.2', unchanged: true })

    // Fork into another org by a member there: public set only, no data copied.
    await h.ports.db.insert(schema.user).values({ id: 'u2', name: 'u2', email: 'u2@example.org' })
    await h.ports.db.insert(schema.organization).values({ id: 'org2', name: 'Two', slug: 'two' })
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'org2', userId: 'u2', role: 'owner' })
    const putsBefore = h.bucket.puts
    res = await h.request(`${base}/fork`, {
      method: 'POST',
      user: 'u2',
      json: { targetOrg: 'two' },
    })
    expect(res.status).toBe(201)
    const fork = await json(res)
    expect(fork).toMatchObject({
      owner: 'two',
      slug: 'new-one',
      forkedFrom: { version: 'v1.0.2' },
      version: { recordCount: 1 },
    })
    expect(h.bucket.puts - putsBefore).toBeLessThanOrEqual(4) // root, log entry, head.json
    const [child] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, fork.id))
    const repo = await h.ports.stores.forCollection(child!.id)
    const [srcHead] = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.semver, 'v1.0.2'))
    const forkVersion = (
      await h.ports.db
        .select()
        .from(schema.versions)
        .where(eq(schema.versions.collectionId, child!.id))
    )[0]!
    const srcRoot = await repo.root(srcHead!.hash)
    const forkRoot = await repo.root(forkVersion.hash)
    expect(forkRoot.public).toEqual(srcRoot.public)
    expect(forkRoot.private).toBe(null)
    expect((await readHead(repo, child!.id))?.seq).toBe(1)
    await expect(verifyLog(repo, child!.id, [h.signer.publicKey])).resolves.toBeTruthy()
    // The fork can push on top of its first version.
    const fsid = (
      await json(
        await h.request('/api/collections/two/new-one/push', {
          method: 'POST',
          user: 'u2',
          json: { base: 'v1.0.0' },
        }),
      )
    ).session_id
    await h.request(`/api/collections/two/new-one/push/${fsid}/records`, {
      method: 'POST',
      user: 'u2',
      ndjson: [{ id: 'c', type: 'Author', data: { name: 'C' } }],
    })
    expect(
      (
        await h.request(`/api/collections/two/new-one/push/${fsid}/commit`, {
          method: 'POST',
          user: 'u2',
        })
      ).status,
    ).toBe(201)

    // Rename and visibility; transfer needs admin in both orgs.
    res = await h.request(base, { method: 'PATCH', user, json: { slug: 'renamed', public: false } })
    expect(await json(res)).toEqual({ ok: true, slug: 'renamed' })
    expect((await h.request('/api/collections/org/renamed')).status).toBe(404)
    expect(
      (
        await h.request('/api/collections/org/renamed/transfer', {
          method: 'POST',
          user,
          json: { targetOrgSlug: 'two' },
        })
      ).status,
    ).toBe(403)
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'org2', userId: user, role: 'admin' })
    res = await h.request('/api/collections/org/renamed/transfer', {
      method: 'POST',
      user,
      json: { targetOrgSlug: 'two' },
    })
    expect(await json(res)).toEqual({ ok: true, newOwner: 'two' })
    expect(
      (await h.request('/api/collections/two/renamed', { method: 'DELETE', user })).status,
    ).toBe(200)
    expect((await h.request('/api/collections/two/renamed', { user })).status).toBe(404)
  })

  it('keeps the description given at creation until a version gives one', async () => {
    const h = await harness()
    const user = await h.member()
    const res = await h.request('/api/accounts/org/collections', {
      method: 'POST',
      user,
      json: { slug: 'described', description: '  Authors and books  ', public: true },
    })
    expect(res.status).toBe(201)
    const base = '/api/collections/org/described'
    const push = async (metadata: Record<string, unknown>, name: string) => {
      const sid = (
        await json(
          await h.request(`${base}/push`, {
            method: 'POST',
            user,
            json: { schemas: { Author }, metadata },
          }),
        )
      ).session_id
      await h.request(`${base}/push/${sid}/records`, {
        method: 'POST',
        user,
        ndjson: [{ id: 'a', type: 'Author', data: { name } }],
      })
      expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
        201,
      )
    }
    expect((await json(await h.request(base))).description).toBe('Authors and books')
    await push({ title: 'T' }, 'A')
    expect((await json(await h.request(base))).description).toBe('Authors and books')
    await push({ title: 'T', description: 'From the push' }, 'B')
    expect((await json(await h.request(base))).description).toBe('From the push')
  })

  it("returns the collection's ARK and each version's, and members see who pushed", async () => {
    const h = await harness()
    const user = await h.member()
    await h.request('/api/accounts/org/collections', {
      method: 'POST',
      user,
      json: { slug: 'with-ark', public: true },
    })
    const base = '/api/collections/org/with-ark'
    const sid = (
      await json(
        await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
      )
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [{ id: 'a', type: 'Author', data: { name: 'A' } }],
    })
    await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
    const col = await json(await h.request(base))
    expect(col.ark).toMatch(/\/ark:\d+\/ul\w+$/)
    expect(col.latestVersion.ark).toBe(`${col.ark}.v1.0.0`)
    // Who pushed: a name for members, nothing for the public.
    expect(col.latestVersion).not.toHaveProperty('pushedByName')
    const mine = await json(await h.request(base, { user }))
    expect(mine.latestVersion.pushedByName).toBe('u1')
    await h.ports.db
      .insert(schema.organization)
      .values({ id: 'personal-u1', name: 'u1', slug: 'u1-home', isDefault: true })
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'personal-u1', userId: user, role: 'owner' })
    const linked = await json(await h.request(base, { user }))
    expect(linked.latestVersion.pushedBySlug).toBe('u1-home')
    const [mineListed] = await json(await h.request(`${base}/versions`, { user }))
    expect(mineListed.pushedByName).toBe('u1')
    const [listed] = await json(await h.request(`${base}/versions`))
    expect(listed.ark).toBe(`${col.ark}.v1.0.0`)
    expect((await json(await h.request(`${base}/versions/1.0.0`))).ark).toBe(`${col.ark}.v1.0.0`)

    // A disabled ARK isn't shown.
    await h.request(`${base}/ark`, { method: 'PATCH', user, json: { enabled: false } })
    expect((await json(await h.request(base))).ark).toBeNull()
  })

  it('lets a key confined to a collection write to it but never manage it', async () => {
    const { h, call } = await setup()
    const owner = await h.member('u1')
    const c = await h.collection('c')
    const base = '/api/collections/org/c'
    for (const key of [`scoped-admin:${c.id}`, `scoped-write:${c.id}`]) {
      const as = (method: string, path: string, json?: unknown) =>
        call(path, { method, user: owner, key, ...(json !== undefined ? { json } : {}) })
      for (const res of [
        await as('PATCH', base, { public: true }),
        await as('DELETE', base),
        await as('POST', `${base}/transfer`, { targetOrgSlug: 'org' }),
      ]) {
        expect(res.status).toBe(403)
        expect((await json(res)).error).toBe('This key cannot manage collections')
      }
      // Webhooks and mirrors are an owner's or admin's, which the key never is.
      expect((await as('GET', `${base}/webhooks`)).status).toBe(403)
      expect((await as('POST', `${base}/webhooks`, { url: 'https://example.org/h' })).status).toBe(
        403,
      )
      expect((await as('POST', `${base}/placements`, { locationId: 'x' })).status).toBe(403)
      // Name, slug and metadata are a writer's.
      expect((await as('PATCH', base, { name: 'Renamed' })).status).toBe(200)
      expect((await as('POST', `${base}/metadata`, { description: 'd' })).status).toBe(422)
    }
    const [row] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(row).toMatchObject({ public: false, name: 'Renamed', deletedAt: null })
    // The owner's session still manages it.
    expect(
      (await call(base, { method: 'PATCH', user: owner, json: { public: true } })).status,
    ).toBe(200)
  })
})
