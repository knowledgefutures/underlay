import {
  iterate,
  memoryStore,
  openRepo,
  type PackObject,
  receiveVersion,
  recordTree,
  type Repo,
  RepoSource,
  untar,
  verifyLogEntries,
  type LogEntry,
  type CollectionInfo,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const rec = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'Author',
  data: { name },
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

async function* packObjects(res: Response): AsyncGenerator<PackObject> {
  for await (const f of untar(res.body!)) yield { key: f.name, bytes: f.bytes }
}

async function records(repo: Repo, version: string) {
  const root = await repo.root(version)
  const out: string[] = []
  for (const [slug, t] of Object.entries(root.public.types)) {
    for await (const e of iterate(new RepoSource(recordTree, repo), t.root, { payloads: true })) {
      out.push(`${slug}/${e.key}:${e.body}`)
    }
  }
  return out
}

async function setup() {
  const h = await harness()
  const user = await h.member()
  const c = await h.collection('authors')
  await h.ports.db
    .update(schema.collections)
    .set({ public: true })
    .where(eq(schema.collections.id, c.id))
  const path = '/api/collections/org/authors'
  const v1 = await push(h, user, path, { schemas: { Author } }, [
    ...Array.from({ length: 2000 }, (_, i) => rec(`a${i}`, `n${i}`)),
    rec('secret', 'hidden', { private: true }),
  ])
  const v2 = await push(h, user, path, {}, [rec('a7', 'changed'), rec('b1', 'new')])
  return { h, user, c, path, v1, v2 }
}

describe('sync endpoints', () => {
  it('serves packs a client can receive, whole and incremental', async () => {
    const { h, path, v1, v2 } = await setup()
    const local = openRepo(memoryStore())
    const res1 = await h.request(`${path}/versions/${v1.semver}/pack`)
    expect(res1.status).toBe(200)
    expect(res1.headers.get('x-underlay-version')).toBe(v1.hash)
    await receiveVersion(local, packObjects(res1), { target: v1.hash })
    const res2 = await h.request(`${path}/versions/${v2.semver}/pack?base=${v1.semver}`)
    const got = await receiveVersion(local, packObjects(res2), { target: v2.hash, base: v1.hash })
    expect(got.objects).toBeLessThan(10)

    const server = await h.ports.stores.forCollection(
      (await h.ports.db.select().from(schema.collections))[0]!.id,
    )
    expect(await records(local, v2.hash)).toEqual(await records(server, v2.hash))
    expect((await records(local, v2.hash)).some((r) => r.includes('secret'))).toBe(false)
  })

  it('sends private sets only to members', async () => {
    const { h, user, path, v1 } = await setup()
    expect((await h.request(`${path}/versions/${v1.semver}/pack?sets=all`)).status).toBe(403)
    const res = await h.request(`${path}/versions/${v1.semver}/pack?sets=all`, { user })
    expect(res.status).toBe(200)
    const local = openRepo(memoryStore())
    await receiveVersion(local, packObjects(res), { target: v1.hash, sets: 'all' })
    const root = await local.root(v1.hash)
    const priv = await local.privateSet(root.private!)
    expect(priv.types.Author!.count).toBe(1)
  })

  it('hides private collections, and refuses foreign or unknown bases', async () => {
    const { h, user, c, path, v1 } = await setup()
    expect((await h.request(`${path}/versions/${v1.semver}/pack?base=v9.9.9`)).status).toBe(404)
    expect((await h.request(`${path}/versions/${v1.semver}/pack?sets=some`)).status).toBe(400)
    // A version of another collection is not a base here, even by hash.
    await h.collection('other')
    const other = await push(h, user, '/api/collections/org/other', { schemas: { Author } }, [
      rec('x', 'y'),
    ])
    const foreign = await h.request(`${path}/versions/${v1.semver}/pack?base=${other.hash}`, {
      user,
    })
    expect(foreign.status).toBe(404)
    await h.ports.db
      .update(schema.collections)
      .set({ public: false })
      .where(eq(schema.collections.id, c.id))
    expect((await h.request(`${path}/versions/${v1.semver}/pack`)).status).toBe(404)
    expect((await h.request(`${path}/log`)).status).toBe(404)
    expect((await h.request(`${path}/versions/${v1.semver}/pack`, { user })).status).toBe(200)
  })

  it('serves the signed log with the keys that verify it', async () => {
    const { h, path, v1, v2 } = await setup()
    const body = (await (await h.request(`${path}/log`)).json()) as {
      collection: CollectionInfo
      head: { seq: number; entryHash: string }
      entries: LogEntry[]
    }
    expect(body.collection.keys).toHaveLength(1)
    expect(body.collection.keys[0]!.id).toBe(h.signer.keyId)
    expect(body.entries.map((e) => e.versionHash)).toEqual([v1.hash, v2.hash])
    const head = await verifyLogEntries(body.entries, body.collection.keys, null)
    expect(head).toEqual({ seq: 2, entryHash: body.head.entryHash })
    // Incremental: entries after a verified head.
    const rest = (await (await h.request(`${path}/log?after=1`)).json()) as { entries: LogEntry[] }
    const first = await verifyLogEntries(body.entries.slice(0, 1), body.collection.keys, null)
    expect(await verifyLogEntries(rest.entries, body.collection.keys, first)).toEqual(head)
    // A tampered entry fails.
    const bad = { ...rest.entries[0]!, message: 'forged' }
    await expect(verifyLogEntries([bad], body.collection.keys, first)).rejects.toThrow(/signature/)
  })
})
