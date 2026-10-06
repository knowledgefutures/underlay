import { createHash } from 'node:crypto'

import {
  type CollectionInfo,
  collectionOwner,
  isPublicCollection,
  openRepo,
  PrefixedStore,
  readCollectionInfo,
  s3Store,
  writeCollectionInfo,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { type FakeS3, startFakeS3 } from '../../protocol/test/stores/fake-s3.js'
import * as schema from '../src/db/schema.js'
import { INFO_BACKFILL_MARKER, queueInfoBackfill } from '../src/versions/collection-info.js'
import { cleanup, type Harness, harness } from './harness.js'

const fakes: FakeS3[] = []
afterAll(async () => {
  for (const f of fakes.splice(0)) await f.close()
  await cleanup()
})

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Book = {
  type: 'object',
  properties: { title: { type: 'string' }, cover: { type: 'object' } },
}
const book = (id: string, data: Record<string, unknown> = { title: id }, extra = {}) => ({
  id,
  type: 'Book',
  data,
  ...extra,
})

async function push(h: Harness, user: string, path: string, open: object, records: unknown[]) {
  const res = await h.request(`${path}/push`, { method: 'POST', user, json: open })
  const sid = ((await res.json()) as { session_id: string }).session_id
  await h.request(`${path}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  const commit = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
  expect(commit.status).toBe(201)
  return (await commit.json()) as { semver: string; hash: string }
}

/** A collection with one version, public or not. */
async function setup(opts: { public?: boolean } = {}) {
  const h = await harness()
  const user = await h.member()
  const c = await h.collection('books')
  if (opts.public) {
    await h.ports.db
      .update(schema.collections)
      .set({ public: true })
      .where(eq(schema.collections.id, c.id))
  }
  const path = '/api/collections/org/books'
  const v1 = await push(h, user, path, { schemas: { Book } }, [book('a'), book('b')])
  const repo = await h.ports.stores.forCollection(c.id)
  return { h, user, c, path, v1, repo }
}

describe('collection.json', () => {
  it('a commit writes the owner, visibility and description (spec 11.1)', async () => {
    const { h, c, repo } = await setup()
    const info = await readCollectionInfo(repo, c.id)
    expect(info).toMatchObject({
      id: c.id,
      owner: { id: 'org1', did: null, handle: 'org', name: 'Org' },
      slug: 'books',
      name: 'books',
      description: null,
      visibility: 'private',
      ark: null,
    })
    expect(info!.keys.map((k) => k.id)).toEqual([h.signer.keyId])
  })

  it('is rewritten when the collection or its owner changes without a version', async () => {
    const { h, user, c, path, repo } = await setup()
    const patch = await h.request(path, {
      method: 'PATCH',
      user,
      json: { name: 'Books', slug: 'library', public: true },
    })
    expect(patch.status).toBe(200)
    await h.drain()
    let info = await readCollectionInfo(repo, c.id)
    expect(info).toMatchObject({ slug: 'library', name: 'Books', visibility: 'public' })
    // The keys that signed the log stay listed.
    expect(info!.keys.map((k) => k.id)).toEqual([h.signer.keyId])

    const rename = await h.request('/api/accounts/org', {
      method: 'PATCH',
      user,
      json: { slug: 'the-press', displayName: 'The Press' },
    })
    expect(rename.status).toBe(200)
    await h.drain()
    info = await readCollectionInfo(repo, c.id)
    expect(info!.owner).toEqual({ id: 'org1', did: null, handle: 'the-press', name: 'The Press' })

    // Enabling the ARK puts it in the file.
    const ark = await h.request('/api/collections/the-press/library/ark', {
      method: 'PATCH',
      user,
      json: { enabled: true },
    })
    expect(ark.status).toBe(200)
    await h.drain()
    info = await readCollectionInfo(repo, c.id)
    expect(info!.ark).toMatch(/^ark:\d+\//)
  })

  it('a collection with no version yet gets no file until its first commit', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('empty')
    const repo = await h.ports.stores.forCollection(c.id)
    await h.request('/api/collections/org/empty', { method: 'PATCH', user, json: { name: 'E' } })
    await h.drain()
    expect(await readCollectionInfo(repo, c.id)).toBeNull()
  })

  it('a mirror holding a version gets each rewrite', async () => {
    const { h, user, c, path } = await setup()
    const f = await startFakeS3('bucket', 0)
    fakes.push(f)
    const loc = await h.request('/api/orgs/org/locations', {
      method: 'POST',
      user,
      json: {
        name: 'm',
        endpoint: f.url,
        bucket: 'bucket',
        prefix: 'm',
        accessKeyId: 'AKID',
        secretAccessKey: 'secret',
      },
    })
    const locationId = ((await loc.json()) as { location: { id: string } }).location.id
    await h.request(`${path}/placements`, {
      method: 'POST',
      user,
      json: { locationId, sets: 'public' },
    })
    await h.drain()
    const mirror = openRepo(
      new PrefixedStore(
        s3Store({
          endpoint: f.url,
          bucket: 'bucket',
          accessKeyId: 'AKID',
          secretAccessKey: 'secret',
        }),
        'm',
      ),
    )
    expect((await readCollectionInfo(mirror, c.id))!.visibility).toBe('private')
    await h.request(path, { method: 'PATCH', user, json: { public: true } })
    await h.drain()
    expect((await readCollectionInfo(mirror, c.id))!.visibility).toBe('public')
  })

  it('the backfill rewrites files in the earlier form, once', async () => {
    const { h, c, repo } = await setup()
    const legacy: CollectionInfo = {
      id: c.id,
      owner: 'org',
      slug: 'books',
      name: 'books',
      keys: (await readCollectionInfo(repo, c.id))!.keys,
    }
    await writeCollectionInfo(repo, legacy)
    const read = (await readCollectionInfo(repo, c.id))!
    // Readers take the earlier form: the owner by handle, and not public.
    expect(collectionOwner(read)).toEqual({ id: null, did: null, handle: 'org', name: 'org' })
    expect(isPublicCollection(read)).toBe(false)

    await queueInfoBackfill(h.ports)
    await h.drain()
    expect(await readCollectionInfo(repo, c.id)).toMatchObject({
      owner: { id: 'org1', handle: 'org' },
      visibility: 'private',
    })
    expect(await h.ports.stores.internal.head(INFO_BACKFILL_MARKER)).toBeTruthy()
    // Once: a second call queues nothing.
    await writeCollectionInfo(repo, legacy)
    await queueInfoBackfill(h.ports)
    expect(await h.drain()).toBe(0)
    expect((await readCollectionInfo(repo, c.id))!.owner).toBe('org')
  })
})

describe('collection URLs (spec 11.3.1)', () => {
  it('the id form serves the same collection, and every response names it', async () => {
    const { h, c, path, v1 } = await setup({ public: true })
    const byHandle = await h.request(path)
    expect(byHandle.headers.get('x-underlay-collection')).toBe(c.id)
    const body = (await byHandle.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      id: c.id,
      owner: { id: 'org1', did: null, handle: 'org', name: 'Org' },
      slug: 'books',
      visibility: 'public',
      versionCount: 1,
      head: { semver: v1.semver, hash: v1.hash },
    })

    const byId = await h.request(`/api/collections/_/${c.id}`)
    expect(byId.status).toBe(200)
    expect(byId.headers.get('x-underlay-collection')).toBe(c.id)
    expect(((await byId.json()) as { head: unknown }).head).toEqual(body.head)

    const records = await h.request(`/api/collections/_/${c.id}/versions/latest/records`)
    expect(records.headers.get('x-underlay-collection')).toBe(c.id)
    expect(((await records.json()) as { records: unknown[] }).records).toHaveLength(2)
    const ndjson = await h.request(`/api/collections/_/${c.id}/versions/latest/records.ndjson`)
    expect(ndjson.headers.get('x-underlay-collection')).toBe(c.id)
    expect((await ndjson.text()).trim().split('\n')).toHaveLength(2)
  })

  it('DIDs and domain handles name no collection yet, and a hidden one sends no id', async () => {
    const { h, c } = await setup()
    for (const owner of ['did:plc:abc', 'press.mit.edu']) {
      expect((await h.request(`/api/collections/${owner}/books`)).status).toBe(404)
    }
    // Private: anonymous callers get the same 404 by either form, and no id.
    for (const url of ['/api/collections/org/books', `/api/collections/_/${c.id}`]) {
      const res = await h.request(url)
      expect(res.status).toBe(404)
      expect(res.headers.get('x-underlay-collection')).toBeNull()
    }
    expect((await h.request(`/api/collections/_/not-an-id`)).status).toBe(404)
  })

  it("a first version's diff counts its files as added", async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('files')
    const path = '/api/collections/org/files'
    const cover = 'cover bytes'
    await h.request(`${path}/files/${sha(cover)}`, { method: 'PUT', user, body: cover })
    await push(h, user, path, { schemas: { Book } }, [
      book('a', { title: 'a', cover: { $file: `sha256:${sha(cover)}` } }),
    ])
    const diff = (await (await h.request(`${path}/versions/latest/diff`, { user })).json()) as {
      from: string | null
      added: unknown[]
      meta: { filesAdded: number }
    }
    expect(diff).toMatchObject({ from: null, meta: { filesAdded: 1 } })
    expect(diff.added).toHaveLength(1)
  })
})
