/**
 * Today's record layout (leaf bodies) and layout F (packs per collection and set)
 * side by side in one location: the same pushes give the same versions, every
 * record reads the same from both, and both pass fsck. Both share the location's
 * node files, so each also reads nodes the other wrote: F's as deltas, today's in full.
 */
import { createHash } from 'node:crypto'

import { fsck, iterate, type RecordSet, RepoSource, recordTree } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { parallelConfig } from '../src/push/parallel.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const defaults = { ...parallelConfig }
afterEach(() => {
  Object.assign(parallelConfig, defaults)
})

const Author = { type: 'object', properties: { name: { type: 'string' } } }
const rec = (id: string, name: string, priv = false) => ({
  id,
  type: 'Author',
  data: { name },
  ...(priv ? { private: true } : {}),
})
const id = (i: number) => `a${String(i).padStart(5, '0')}`

async function push(
  h: Harness,
  user: string,
  path: string,
  open: Record<string, unknown>,
  upserts: unknown[],
  deletes: string[],
  parallel: boolean,
) {
  const res = await h.request(`${path}/push`, { method: 'POST', user, json: open })
  expect(res.status).toBe(200)
  const sid = ((await res.json()) as { session_id: string }).session_id
  if (upserts.length) {
    const r = await h.request(`${path}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: upserts,
    })
    expect(r.status).toBe(200)
  }
  if (deletes.length) {
    const r = await h.request(`${path}/push/${sid}/deletes`, {
      method: 'POST',
      user,
      ndjson: deletes.map((d) => ({ type: 'Author', id: d })),
    })
    expect(r.status).toBe(200)
  }
  Object.assign(
    parallelConfig,
    parallel ? { aboveBytes: 0, unitBytes: 32_000, baseLevel: 0 } : { aboveBytes: Infinity },
  )
  const commit = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
  expect(commit.status).toBe(parallel ? 202 : 201)
  await h.drain()
}

/** Each version's hash, by seq. */
async function versions(h: Harness, collectionId: string) {
  const rows = await h.ports.db
    .select({ seq: schema.versions.seq, hash: schema.versions.hash })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collectionId))
  return rows.sort((a, b) => a.seq - b.seq).map((r) => r.hash)
}

/** Every record of the head version, with its body, read from its set alone. */
async function records(h: Harness, collectionId: string) {
  const [c] = await h.ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  const [v] = await h.ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.id, c!.headVersionId!))
  const repo = await h.ports.stores.forCollection(collectionId)
  const root = await repo.root(v!.hash)
  const out: string[] = []
  const sets: [RecordSet, string | null][] = [['public', root.public.types.Author?.root ?? null]]
  if (root.private)
    sets.push(['private', (await repo.privateSet(root.private)).types.Author?.root ?? null])
  for (const [set, tree] of sets)
    for await (const e of iterate(new RepoSource(recordTree, repo, { set }), tree, {
      payloads: true,
    }))
      out.push(`${set} ${e.key} ${e.body}`)
  return { repo, out }
}

describe("today's layout and layout F side by side", () => {
  it('give the same versions, read the same records, and both pass fsck', async () => {
    const h = await harness()
    const user = await h.member()
    const today = await h.collection('today', { recordLayout: 'today' })
    const f = await h.collection('f', { recordLayout: 'f' })
    // The private set's commitment is salted per collection: the same salt, the same hashes.
    await h.ports.db
      .update(schema.collections)
      .set({ privateSalt: today.privateSalt })
      .where(eq(schema.collections.id, f.id))
    const paths = { today: '/api/collections/org/today', f: '/api/collections/org/f' }

    const first = [
      ...Array.from({ length: 3000 }, (_, i) => rec(id(i), `n${i}`)),
      ...Array.from({ length: 20 }, (_, i) => rec(id(5000 + i), `p${i}`, true)),
    ]
    const second = Array.from({ length: 200 }, (_, i) => rec(id(i * 7), `again${i}`))
    const gone = Array.from({ length: 50 }, (_, i) => id(i * 11 + 1))
    const third = Array.from({ length: 400 }, (_, i) => rec(id(i * 5 + 2), `third${i}`))
    // Interleaved, so each layout reads nodes the other wrote first.
    for (const [upserts, deletes, parallel] of [
      [first, [], false],
      [second, gone, false],
      [third, [], true],
    ] as const) {
      for (const which of ['today', 'f'] as const) {
        const open = upserts === first ? { schemas: { Author } } : {}
        await push(h, user, paths[which], open, [...upserts], [...deletes], parallel)
      }
      expect(await versions(h, f.id)).toEqual(await versions(h, today.id))
    }
    expect(await versions(h, f.id)).toHaveLength(3)

    const a = await records(h, today.id)
    const b = await records(h, f.id)
    expect(b.out).toEqual(a.out)
    // The records the pushes leave: a push's deletes, sent after its upserts, win over
    // them, and the third push brings some deleted ones back.
    const live = new Set(first.map((r) => r.id))
    for (const d of gone) live.delete(d)
    for (const r of third) live.add(r.id)
    expect(a.out.length).toBe(live.size)
    expect(b.repo.records).not.toBeNull()
    expect(a.repo.records).toBeNull()

    for (const c of [today, f]) {
      const repo = await h.ports.stores.forCollection(c.id)
      const report = await fsck(repo, {
        collectionId: c.id,
        trustedKeys: [h.signer.publicKey],
        fileBytes: true,
      })
      expect(report.errors).toEqual([])
    }
    // F's records are its own files, a set apart; today's are leaf bodies.
    const keys = [...h.bucket.objects.keys()]
    expect(keys.some((k) => k.startsWith(`repo/runs/${f.id}/public/packs/`))).toBe(true)
    expect(keys.some((k) => k.startsWith(`repo/runs/${f.id}/private/packs/`))).toBe(true)
    expect(keys.some((k) => k.startsWith(`repo/runs/${today.id}/`))).toBe(false)
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    expect(sha(a.out.join('\n'))).toBe(sha(b.out.join('\n')))
  }, 60_000)
})
