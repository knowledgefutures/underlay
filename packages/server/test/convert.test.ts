/**
 * Converting a collection from today's layout to layout F (layouts/convert.ts):
 * every version keeps its hash and reads the same, a push made while converting is
 * converted too, the switch waits for a committing push, commits wait out the
 * switch, and a version written in one layout never publishes in the other.
 */
import {
  fsck,
  iterate,
  type LayoutName,
  type RecordSet,
  RepoSource,
  recordTree,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { conversionState, convertConfig, startConversion } from '../src/layouts/convert.js'
import { parallelConfig } from '../src/push/parallel.js'
import { publishVersion } from '../src/versions/publish.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const defaults = { parallel: { ...parallelConfig }, convert: { ...convertConfig } }
afterEach(() => {
  Object.assign(parallelConfig, defaults.parallel)
  Object.assign(convertConfig, defaults.convert)
})

const Author = { type: 'object', properties: { name: { type: 'string' } } }
const rec = (id: string, name: string, priv = false) => ({
  id,
  type: 'Author',
  data: { name },
  ...(priv ? { private: true } : {}),
})
const id = (i: number) => `a${String(i).padStart(5, '0')}`
const PATH = '/api/collections/org/conv'

async function push(
  h: Harness,
  user: string,
  open: Record<string, unknown>,
  upserts: unknown[],
  deletes: string[] = [],
  o: { parallel?: boolean; drain?: boolean } = {},
) {
  const res = await h.request(`${PATH}/push`, { method: 'POST', user, json: open })
  expect(res.status).toBe(200)
  const sid = ((await res.json()) as { session_id: string }).session_id
  if (upserts.length)
    expect(
      (await h.request(`${PATH}/push/${sid}/records`, { method: 'POST', user, ndjson: upserts }))
        .status,
    ).toBe(200)
  if (deletes.length)
    expect(
      (
        await h.request(`${PATH}/push/${sid}/deletes`, {
          method: 'POST',
          user,
          ndjson: deletes.map((d) => ({ type: 'Author', id: d })),
        })
      ).status,
    ).toBe(200)
  Object.assign(
    parallelConfig,
    o.parallel ? { aboveBytes: 0, unitBytes: 32_000, baseLevel: 0 } : { aboveBytes: Infinity },
  )
  const commit = await h.request(`${PATH}/push/${sid}/commit`, { method: 'POST', user })
  if (o.drain !== false) await h.drain()
  return commit
}

async function versions(h: Harness, collectionId: string) {
  const rows = await h.ports.db
    .select({ seq: schema.versions.seq, hash: schema.versions.hash })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collectionId))
  return rows.sort((a, b) => a.seq - b.seq).map((r) => r.hash)
}

/** Every record of version `hash`, with its body, read in `layout` from its set alone. */
async function records(h: Harness, collectionId: string, hash: string, layout: LayoutName) {
  const repo = await h.ports.stores.forCollectionAs(collectionId, layout)
  const root = await repo.root(hash)
  const priv = root.private ? await repo.privateSet(root.private) : null
  const out: string[] = []
  const sets: [RecordSet, typeof root.public | null][] = [
    ['public', root.public],
    ['private', priv],
  ]
  for (const [set, s] of sets)
    for (const [type, t] of Object.entries(s?.types ?? {}))
      for await (const e of iterate(new RepoSource(recordTree, repo, { set, type }), t.root, {
        payloads: true,
      }))
        out.push(`${set} ${type} ${e.key} ${e.body}`)
  return out
}

async function layoutOf(h: Harness, collectionId: string) {
  const [c] = await h.ports.db
    .select({ layout: schema.collections.recordLayout })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  return c!.layout
}

describe("converting a collection from today's layout to F", () => {
  it('keeps every version and record, and converts a push made meanwhile', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('conv', { recordLayout: 'today' })
    const big = rec(id(9999), 'x'.repeat(70_000))
    const first = [
      ...Array.from({ length: 3000 }, (_, i) => rec(id(i), `n${i}`)),
      ...Array.from({ length: 20 }, (_, i) => rec(id(5000 + i), `p${i}`, true)),
      big,
    ]
    await push(h, user, { schemas: { Author } }, first)
    await push(
      h,
      user,
      {},
      Array.from({ length: 200 }, (_, i) => rec(id(i * 7), `again${i}`)),
      Array.from({ length: 50 }, (_, i) => id(i * 11 + 1)),
    )
    await push(
      h,
      user,
      {},
      Array.from({ length: 400 }, (_, i) => rec(id(i * 5 + 2), `third${i}`)),
      [],
      { parallel: true },
    )
    // A few leaves a job: the conversion stops and carries on inside trees.
    Object.assign(convertConfig, { leavesPerJob: 2, switchPauseMs: 0 })
    await startConversion(h.ports, c.id)
    // Committed before the conversion's first job runs: on today's layout, converted too.
    const fourth = await push(h, user, {}, [rec(id(4), 'fourth')], [], { drain: false })
    expect(fourth.status).toBe(201)
    const hashes = await versions(h, c.id)
    expect(hashes).toHaveLength(4)
    const before = await Promise.all(hashes.map((v) => records(h, c.id, v, 'today')))
    await h.drain()

    const state = await conversionState(h.ports, c.id)
    expect(state).toMatchObject({ status: 'switched', seq: 4 })
    expect(state!.stats.jobs).toBeGreaterThan(3)
    expect(state!.stats.records).toBe(new Set(before.flat()).size)
    expect(await layoutOf(h, c.id)).toBe('f')
    expect(await versions(h, c.id)).toEqual(hashes)
    // Every version reads the same from F's packs as from its leaf bodies.
    for (const [i, v] of hashes.entries()) expect(await records(h, c.id, v, 'f')).toEqual(before[i])
    const keys = [...h.bucket.objects.keys()]
    expect(keys.some((k) => k.startsWith(`repo/runs/${c.id}/public/packs/`))).toBe(true)
    expect(keys.some((k) => k.startsWith(`repo/runs/${c.id}/private/packs/`))).toBe(true)
    const repo = await h.ports.stores.forCollection(c.id)
    expect(repo.layout).toBe('f')
    const report = await fsck(repo, { collectionId: c.id, trustedKeys: [h.signer.publicKey] })
    expect(report.errors).toEqual([])

    // Then it commits on F, serially and in parallel.
    await push(h, user, {}, [rec(id(10), 'fifth')])
    await push(
      h,
      user,
      {},
      Array.from({ length: 300 }, (_, i) => rec(id(i * 3), `sixth${i}`)),
      [],
      { parallel: true },
    )
    const after = await versions(h, c.id)
    expect(after).toHaveLength(6)
    const head = await records(h, c.id, after.at(-1)!, 'f')
    expect(head).toContain(
      `public Author ${id(10)} ${JSON.stringify({ id: id(10), type: 'Author', data: { name: 'fifth' } })}`,
    )
    expect(head.filter((l) => l.includes('"sixth'))).toHaveLength(300)
    // A job that runs again after the switch writes nothing.
    expect(
      (await fsck(repo, { collectionId: c.id, trustedKeys: [h.signer.publicKey] })).errors,
    ).toEqual([])
  }, 60_000)

  it('switches only once no push is committing', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('conv', { recordLayout: 'today' })
    await push(h, user, { schemas: { Author } }, [rec(id(1), 'one')])
    // A session mid-commit (as a parallel commit's units would leave it).
    const sid = crypto.randomUUID()
    await h.ports.db.insert(schema.pushSessions).values({
      id: sid,
      collectionId: c.id,
      userId: user,
      status: 'committing',
      expiresAt: new Date(Date.now() + 3_600_000),
    } as typeof schema.pushSessions.$inferInsert)
    Object.assign(convertConfig, { retrySeconds: 3600 })
    await startConversion(h.ports, c.id)
    await h.drain()
    expect(await layoutOf(h, c.id)).toBe('today')
    expect((await conversionState(h.ports, c.id))?.status).toBe('converting')
    // The push finishes; the waiting job switches.
    await h.ports.db
      .update(schema.pushSessions)
      .set({ status: 'failed' })
      .where(eq(schema.pushSessions.id, sid))
    await h.ports.db.update(schema.jobs).set({ runAt: new Date(0) })
    await h.drain()
    expect(await layoutOf(h, c.id)).toBe('f')
  })

  it('makes commits wait out the switch', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('conv', { recordLayout: 'today' })
    await push(h, user, { schemas: { Author } }, [rec(id(1), 'one')])
    await startConversion(h.ports, c.id)
    await h.drain()
    expect(await layoutOf(h, c.id)).toBe('f')
    const res = await push(h, user, {}, [rec(id(2), 'two')])
    expect(res.status).toBe(503)
    expect(await versions(h, c.id)).toHaveLength(1)
    convertConfig.switchPauseMs = 0
    expect((await push(h, user, {}, [rec(id(2), 'two')])).status).toBe(201)
  })

  it('never publishes a version in a layout the collection has left', async () => {
    const h = await harness()
    const c = await h.collection('conv', { recordLayout: 'today' })
    await h.ports.db
      .update(schema.collections)
      .set({ recordLayout: 'f' })
      .where(eq(schema.collections.id, c.id))
    const versionId = crypto.randomUUID()
    const published = await publishVersion(h.ports.db, {
      fence: 0,
      recordLayout: 'today',
      version: {
        id: versionId,
        collectionId: c.id,
        seq: 1,
        semver: 'v1.0.0',
        major: 1,
        minor: 0,
        patch: 0,
        hash: 'ulv2:' + '0'.repeat(64),
        baseSemver: null,
        message: null,
        pushedBy: null,
        appId: null,
        actorId: null,
        recordCount: 0,
        publicRecordCount: 0,
        fileCount: 0,
        totalBytes: 0,
        publicFileCount: 0,
        publicTotalBytes: 0,
        typeCounts: {},
        publicTypeCounts: {},
        hasPrivate: false,
        publicRefsRoot: null,
        privateRefsRoot: null,
        changes: { added: 0, removed: 0, updated: 0 },
      },
      baseVersionId: null,
      collectionUpdate: { publicFilesRoot: null, summary: null },
      schemaHashes: [],
      usage: [],
    })
    expect(published).toMatchObject({ ok: false, layoutMoved: true })
    expect(await versions(h, c.id)).toEqual([])
  })
})
