import { readHead, verifyLog } from '@underlay/repo'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

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
      forkedFrom: { version: 'v1.0.1' },
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
      .where(eq(schema.versions.semver, 'v1.0.1'))
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
})
