import { createHash } from 'node:crypto'

import { readCollectionInfo, verifyLog } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { type FakeS3, startFakeS3 } from '../../protocol/test/stores/fake-s3.js'
import * as schema from '../src/db/schema.js'
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
  required: ['title'],
}

async function push(h: Harness, user: string, path: string, open: object, records: unknown[]) {
  const res = await h.request(`${path}/push`, { method: 'POST', user, json: open })
  const sid = ((await res.json()) as { session_id: string }).session_id
  await h.request(`${path}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  const commit = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
  expect(commit.status).toBe(201)
  return (await commit.json()) as { semver: string; hash: string }
}

async function location(h: Harness, user: string, f: FakeS3) {
  const res = await h.request('/api/orgs/org/locations', {
    method: 'POST',
    user,
    json: {
      name: 'backup',
      endpoint: f.url,
      bucket: 'bucket',
      prefix: 'backup',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      permissions: 'read_write',
    },
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { location: { id: string } }).location.id
}

/** Instance A: a collection with private records and a file, mirrored to a bucket. */
async function source() {
  const f = await startFakeS3('bucket')
  fakes.push(f)
  const a = await harness()
  const user = await a.member()
  const c = await a.collection('books')
  const path = '/api/collections/org/books'
  const cover = 'cover bytes'
  await a.request(`${path}/files/${sha(cover)}`, { method: 'PUT', user, body: cover })
  const versions = [
    await push(a, user, path, { schemas: { Book } }, [
      ...Array.from({ length: 1500 }, (_, i) => ({
        id: `b${i}`,
        type: 'Book',
        data: { title: `T${i}` },
      })),
      { id: 'c', type: 'Book', data: { title: 'c', cover: { $file: `sha256:${sha(cover)}` } } },
      { id: 'secret', type: 'Book', data: { title: 'hidden' }, private: true },
    ]),
    await push(a, user, path, {}, [{ id: 'b1', type: 'Book', data: { title: 'changed' } }]),
  ]
  const loc = await location(a, user, f)
  await a.request(`${path}/placements`, {
    method: 'POST',
    user,
    json: { locationId: loc, sets: 'public+private' },
  })
  await a.drain()
  return { f, a, c, versions, cover }
}

async function records(h: Harness, user: string, path: string) {
  const res = await h.request(`${path}/versions/latest/records.ndjson`, { user })
  return (await res.text()).split('\n').filter(Boolean).sort()
}

async function restore(
  b: Harness,
  user: string,
  loc: string,
  collectionId: string,
  trust: string[],
) {
  const res = await b.request('/api/orgs/org/restores', {
    method: 'POST',
    user,
    json: { locationId: loc, collectionId, slug: 'restored', trustKeyIds: trust },
  })
  expect(res.status).toBe(202)
  const id = ((await res.json()) as { restore: { id: string } }).restore.id
  await b.drain()
  const status = await b.request(`/api/orgs/org/restores/${id}`, { user })
  return (
    (await status.json()) as {
      restore: { status: string; error: string | null; restoredSeq: number }
    }
  ).restore
}

describe('restore', () => {
  it('rebuilds a collection on another instance from its mirror, history and all', async () => {
    const { f, a, c, versions, cover } = await source()
    const b = await harness()
    const user = await b.member()
    const loc = await location(b, user, f)

    // B's own key didn't sign this log: it must be told which key to trust.
    const refused = await restore(b, user, loc, c.id, [])
    expect(refused.status).toBe('failed')
    expect(refused.error).toMatch(/No trusted key/)
    await b.ports.db.delete(schema.collections).where(eq(schema.collections.slug, 'restored'))

    const done = await restore(b, user, loc, c.id, [a.signer.keyId])
    expect(done).toMatchObject({ status: 'done', restoredSeq: 2, error: null })
    const path = '/api/collections/org/restored'
    const list = (await (await b.request(`${path}/versions`, { user })).json()) as {
      semver: string
      hash: string
    }[]
    expect(list.map((v) => [v.semver, v.hash]).sort()).toEqual(
      versions.map((v) => [v.semver, v.hash]).sort(),
    )
    expect(await records(b, user, path)).toEqual(
      await records(a, 'u1', '/api/collections/org/books'),
    )
    const file = await b.request(`${path}/files/${sha(cover)}`, { user })
    expect(file.status).toBe(302)

    // The restored log verifies against the original key, and new versions extend it.
    const [restored] = await b.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.slug, 'restored'))
    await push(b, user, path, {}, [{ id: 'after', type: 'Book', data: { title: 'after restore' } }])
    const repo = await b.ports.stores.forCollection(restored!.id)
    const info = await readCollectionInfo(repo, restored!.id)
    expect(info!.keys.map((k) => k.id).sort()).toEqual([a.signer.keyId, b.signer.keyId].sort())
    const { entries } = await verifyLog(repo, restored!.id, info!.keys)
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('refuses a tampered bucket', async () => {
    const { f, a, c } = await source()
    // Swap one body for another: both are well-formed gzip, neither belongs there.
    const bodies = [...f.objects.keys()].filter((k) => k.startsWith('backup/bodies/'))
    const [x, y] = [bodies[0]!, bodies[1]!]
    f.objects.set(x, f.objects.get(y)!)
    const b = await harness()
    const user = await b.member()
    const loc = await location(b, user, f)
    const r = await restore(b, user, loc, c.id, [a.signer.keyId])
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/fails its hash|line count/)
  })
})
