import { createHash } from 'node:crypto'

import {
  iterate,
  openRepo,
  PrefixedStore,
  readCollectionInfo,
  readHead,
  recordTree,
  type Repo,
  RepoSource,
  s3Store,
  verifyLog,
  verifyTree,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { type FakeS3, startFakeS3 } from '../../protocol/test/stores/fake-s3.js'
import * as schema from '../src/db/schema.js'
import { mirrorConfig } from '../src/locations/mirror.js'
import { cleanup, type Harness, harness } from './harness.js'

const fakes: FakeS3[] = []
afterAll(async () => {
  for (const f of fakes.splice(0)) await f.close()
  await cleanup()
})
const defaults = { ...mirrorConfig }
afterEach(() => Object.assign(mirrorConfig, defaults))

async function fake(opts: { publicRead?: boolean } = {}) {
  const f = await startFakeS3('bucket', 0, opts)
  fakes.push(f)
  return f
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Book = {
  type: 'object',
  properties: { title: { type: 'string' }, cover: { type: 'object' } },
  required: ['title'],
}
const book = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'Book',
  data: { title },
  ...extra,
})

async function push(
  h: Harness,
  user: string,
  path: string,
  open: object,
  records: unknown[],
  deletes: unknown[] = [],
) {
  const res = await h.request(`${path}/push`, { method: 'POST', user, json: open })
  const sid = ((await res.json()) as { session_id: string }).session_id
  if (records.length)
    await h.request(`${path}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  if (deletes.length)
    await h.request(`${path}/push/${sid}/deletes`, { method: 'POST', user, ndjson: deletes })
  const commit = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
  expect(commit.status).toBe(201)
  return (await commit.json()) as { semver: string; hash: string }
}

async function addLocation(
  h: Harness,
  user: string,
  f: FakeS3,
  prefix: string,
  extra: object = {},
) {
  const res = await h.request('/api/orgs/org/locations', {
    method: 'POST',
    user,
    json: {
      name: prefix,
      endpoint: f.url,
      bucket: 'bucket',
      prefix,
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      permissions: 'read_write',
      ...extra,
    },
  })
  return {
    status: res.status,
    body: (await res.json()) as {
      location: { id: string; status: string }
      check: { ok: boolean; publicRead: boolean; readBack: boolean }
    },
  }
}

/** The mirror as a reader sees it: a repository in the bucket, verified. */
function mirrorRepo(f: FakeS3, prefix: string): Repo {
  const store = s3Store({
    endpoint: f.url,
    bucket: 'bucket',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  })
  return openRepo(new PrefixedStore(store, prefix))
}

async function placements(h: Harness, user: string, path: string) {
  const res = await h.request(`${path}/placements`, { user })
  return (await res.json()) as {
    headSeq: number
    placements: {
      id: string
      role: string
      sets: string
      state: string
      syncedSeq: number
      lag: number
      lastError: string | null
      inherited: boolean
    }[]
  }
}

async function setup() {
  const h = await harness()
  const user = await h.member()
  const c = await h.collection('books')
  const path = '/api/collections/org/books'
  const cover = 'cover bytes'
  expect(
    (await h.request(`${path}/files/${sha(cover)}`, { method: 'PUT', user, body: cover })).status,
  ).toBe(201)
  const v1 = await push(h, user, path, { schemas: { Book } }, [
    ...Array.from({ length: 2500 }, (_, i) => book(`b${i}`, `T${i}`)),
    book('cover', 'with a cover', {
      data: { title: 'c', cover: { $file: `sha256:${sha(cover)}` } },
    }),
    book('secret', 'hidden', { private: true }),
  ])
  const v2 = await push(
    h,
    user,
    path,
    {},
    [book('b1', 'changed'), book('new', 'new')],
    [{ type: 'Book', id: 'b2' }],
  )
  return { h, user, c, path, cover, v1, v2 }
}

describe('bucket mirrors', () => {
  it('adds a location, mirrors the history, and the bucket reads as a repository', async () => {
    const { h, user, c, path, cover, v2 } = await setup()
    const f = await fake()
    const loc = await addLocation(h, user, f, 'mirror')
    expect(loc.status).toBe(201)
    expect(loc.body.check).toMatchObject({ ok: true, publicRead: false, readBack: true })
    const list = await (await h.request('/api/orgs/org/locations', { user })).json()
    expect(JSON.stringify(list)).not.toContain('secret')

    const created = await h.request(`${path}/placements`, {
      method: 'POST',
      user,
      json: { locationId: loc.body.location.id, sets: 'public+private' },
    })
    expect(created.status).toBe(201)
    await h.drain()
    const status = await placements(h, user, path)
    const mirror = status.placements.find((p) => p.role === 'mirror')!
    expect(mirror).toMatchObject({
      syncedSeq: 2,
      lag: 0,
      state: 'active',
      lastError: null,
      inherited: false,
    })

    // A third party with read access sees a complete, verifiable repository.
    const repo = mirrorRepo(f, 'mirror')
    const head = await readHead(repo, c.id)
    expect(head).toMatchObject({ seq: 2, versionHash: v2.hash })
    const info = await readCollectionInfo(repo, c.id)
    const { entries } = await verifyLog(repo, c.id, info!.keys)
    expect(entries).toHaveLength(2)
    const root = await repo.root(v2.hash)
    const priv = await repo.privateSet(root.private!)
    const src = new RepoSource(recordTree, repo)
    for (const t of [root.public.types.Book!, priv.types.Book!]) {
      expect((await verifyTree(src, t.root)).errors).toEqual([])
      let n = 0
      for await (const e of iterate(src, t.root, { payloads: true })) if (e.body) n++
      expect(n).toBe(t.count)
    }
    expect(root.public.types.Book!.count).toBe(2501)
    expect(priv.types.Book!.count).toBe(1)
    const file = await repo.blobs.get(`files/${sha(cover)}`)
    expect(sha(await file!.text())).toBe(sha(cover))

    // The next version copies only what changed.
    const before = f.requests.length
    await push(h, user, path, {}, [book('b5', 'again')])
    await h.drain()
    expect(
      (await placements(h, user, path)).placements.find((p) => p.role === 'mirror')!.syncedSeq,
    ).toBe(3)
    const puts = f.requests.slice(before).filter((r) => r.method === 'PUT').length
    expect(puts).toBeLessThan(20)
  })

  it('copies in budgeted steps, and a public mirror holds no private object', async () => {
    const { h, user, c, path, v2 } = await setup()
    const f = await fake()
    const loc = await addLocation(h, user, f, 'pub')
    mirrorConfig.objectsPerJob = 3
    await h.request(`${path}/placements`, {
      method: 'POST',
      user,
      json: { locationId: loc.body.location.id, sets: 'public' },
    })
    await h.drain()
    const repo = mirrorRepo(f, 'pub')
    expect((await readHead(repo, c.id))?.versionHash).toBe(v2.hash)
    const root = await repo.root(v2.hash)
    const src = new RepoSource(recordTree, repo)
    expect((await verifyTree(src, root.public.types.Book!.root)).errors).toEqual([])
    const keys = [...f.objects.keys()].filter((k) => k.startsWith('pub/'))
    // Resumed copies don't redo work: about one write per object.
    const puts = f.requests.filter((r) => r.method === 'PUT' && r.url.includes('/pub/')).length
    expect(puts).toBeLessThanOrEqual(keys.length + 5)
    expect(keys.some((k) => k.startsWith('pub/private/'))).toBe(false)
    // The private tree's nodes aren't there either.
    const server = await h.ports.stores.forCollection(c.id)
    const sroot = await server.root(v2.hash)
    const privRoot = (await server.privateSet(sroot.private!)).types.Book!.root!
    expect(
      f.objects.has(`bucket/pub/nodes/${privRoot}`) || keys.includes(`pub/nodes/${privRoot}`),
    ).toBe(false)
  })

  it('refuses private sets on a bucket anyone can read, and broken locations', async () => {
    const { h, user, path } = await setup()
    const open = await fake({ publicRead: true })
    const loc = await addLocation(h, user, open, 'open')
    expect(loc.body.check.publicRead).toBe(true)
    const priv = await h.request(`${path}/placements`, {
      method: 'POST',
      user,
      json: { locationId: loc.body.location.id, sets: 'public+private' },
    })
    expect(priv.status).toBe(422)
    const pub = await h.request(`${path}/placements`, {
      method: 'POST',
      user,
      json: { locationId: loc.body.location.id, sets: 'public' },
    })
    expect(pub.status).toBe(201)

    const f = await fake()
    const broken = await addLocation(h, user, f, 'x', { bucket: 'no-such-bucket' })
    expect(broken.body.check.ok).toBe(false)
    expect(broken.body.location.status).toBe('broken')
  })

  it('records errors, and catches up once the location works again', async () => {
    const { h, user, path } = await setup()
    const f = await fake()
    const loc = await addLocation(h, user, f, 'm')
    await h.request(`${path}/placements`, {
      method: 'POST',
      user,
      json: { locationId: loc.body.location.id, sets: 'public' },
    })
    await h.drain()
    // The bucket goes away.
    await h.ports.db
      .update(schema.storageLocations)
      .set({ bucket: 'gone' })
      .where(eq(schema.storageLocations.id, loc.body.location.id))
    await push(h, user, path, {}, [book('later', 'later')])
    await h.drain()
    let m = (await placements(h, user, path)).placements.find((p) => p.role === 'mirror')!
    expect(m.state).toBe('error')
    expect(m.lastError).toMatch(/404|NoSuchBucket/)
    expect(m.lag).toBe(1)
    // Fixed: the sweep picks it up.
    await h.ports.db
      .update(schema.storageLocations)
      .set({ bucket: 'bucket' })
      .where(eq(schema.storageLocations.id, loc.body.location.id))
    await h.ports.jobs.enqueue({ type: 'maintenance.sweep' })
    await h.drain()
    m = (await placements(h, user, path)).placements.find((p) => p.role === 'mirror')!
    expect(m).toMatchObject({ state: 'active', lag: 0, lastError: null })
  })

  it('applies org defaults to existing and new collections', async () => {
    const { h, user, path } = await setup()
    const f = await fake()
    const loc = await addLocation(h, user, f, 'org')
    const res = await h.request('/api/orgs/org/placements', {
      method: 'POST',
      user,
      json: { locationId: loc.body.location.id, sets: 'public' },
    })
    expect(res.status).toBe(201)
    await h.drain()
    const inherited = (await placements(h, user, path)).placements.find((p) => p.role === 'mirror')!
    expect(inherited).toMatchObject({ syncedSeq: 2, lag: 0, inherited: true })
    // An inherited mirror goes with the default, not per collection.
    expect(
      (await h.request(`${path}/placements/${inherited.id}`, { method: 'DELETE', user })).status,
    ).toBe(409)
    await h.collection('later')
    await push(h, user, '/api/collections/org/later', { schemas: { Book } }, [book('x', 'y')])
    await h.drain()
    const later = await placements(h, user, '/api/collections/org/later')
    expect(later.placements.find((p) => p.role === 'mirror')).toMatchObject({
      syncedSeq: 1,
      lag: 0,
    })
    // Removing the default stops mirroring for the org's collections.
    const id = (
      (await (await h.request('/api/orgs/org/placements', { user })).json()) as {
        placements: { id: string }[]
      }
    ).placements[0]!.id
    expect(
      (await h.request(`/api/orgs/org/placements/${id}`, { method: 'DELETE', user })).status,
    ).toBe(204)
    expect((await placements(h, user, path)).placements.some((p) => p.role === 'mirror')).toBe(
      false,
    )
  })
})
