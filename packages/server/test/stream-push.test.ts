/**
 * One version from any number of uploads: paged run indexes, compaction split
 * into key-range pieces, compaction down to a bounded run count before a
 * commit, plans written in chunks, and the serial commit's size refusal.
 */
import { compareUtf8, memoryStore, sha256Hex } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { compactConfig, pieceCuts } from '../src/push/compact.js'
import { parallelConfig } from '../src/push/parallel.js'
import {
  compactRuns,
  isMark,
  mergeRuns,
  normalizeIndex,
  readRun,
  readRunIndex,
  runConfig,
  type RunEntry,
  type RunIndex,
  writeRun,
} from '../src/push/runs.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)
const defaults = {
  parallel: { ...parallelConfig },
  compact: { ...compactConfig },
  runs: { ...runConfig },
}
afterEach(() => {
  Object.assign(parallelConfig, defaults.parallel)
  Object.assign(compactConfig, defaults.compact)
  Object.assign(runConfig, defaults.runs)
})

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const rec = (id: string, name: string) => ({ id, type: 'Author', data: { name } })
const body = (i: number) => Array.from({ length: 8 }, (_, j) => sha256Hex(`${i}.${j}`)).join('')

describe('run pages', () => {
  it('reads a range across many parts, each part’s blocks from its own page', async () => {
    runConfig.partBytes = 64 * 1024
    const store = memoryStore()
    const entries: RunEntry[] = Array.from({ length: 6000 }, (_, i) => ({
      t: 'T',
      k: `r${String(i).padStart(5, '0')}`,
      b: body(i),
    }))
    const ix = await writeRun(store, 's', 1, entries)
    expect(ix.parts.length).toBeGreaterThan(10)
    const range = { type: 'T', after: 'r01234', through: 'r04321' }
    const got = await collect(readRun(store, 's', ix, range))
    expect(got.map((e) => e.k)).toEqual(entries.slice(1235, 4322).map((e) => e.k))
    // The index read back is the summary the writer returned.
    expect(await readRunIndex(store, 's', 1)).toEqual(ix)
  })

  it('reads an index written before pages (blocks inline)', async () => {
    const store = memoryStore()
    const entries: RunEntry[] = Array.from({ length: 3000 }, (_, i) => ({
      t: 'T',
      k: `k${String(i).padStart(4, '0')}`,
      b: body(i),
    }))
    const ix = await writeRun(store, 's', 1, entries)
    // Rebuild the old form: every block, with its part, in one list.
    const blocks = []
    for (const p of ix.parts) {
      const page = await store.get(`sessions/s/runs/1/${p.part}.blocks.json`)
      blocks.push(...(JSON.parse(await page!.text()) as object[]))
    }
    await store.put('sessions/s/runs/1/index.json', JSON.stringify({ seq: 1, tier: 0, blocks }))
    const old = await readRunIndex(store, 's', 1)
    expect(old.parts.every((p) => p.blocks && p.blocks.length > 0)).toBe(true)
    expect(old.parts.reduce((n, p) => n + p.count, 0)).toBe(3000)
    const got = await collect(
      readRun(store, 's', old, { type: 'T', after: 'k0100', through: 'k0200' }),
    )
    expect(got.length).toBe(100)
    // Slices of old plans normalize the same way.
    expect(normalizeIndex({ seq: 1, tier: 0, blocks: [] as never[] }).parts).toEqual([])
  })

  it('a compaction split into key-range pieces is the same run as one done whole', async () => {
    runConfig.partBytes = 32 * 1024
    const store = memoryStore()
    const runs: RunIndex[] = []
    for (let seq = 1; seq <= 6; seq++) {
      const entries = Array.from({ length: 700 }, (_, i) => {
        const n = (seq * 7919 + i * 104_729) % 3000
        return { t: n % 3 ? 'A' : 'B', k: `k${n}`, b: body(n * 10 + seq), s: seq }
      })
      runs.push(await writeRun(store, 's', seq, entries))
    }
    const whole = await collect(readRun(store, 's', await compactRuns(store, 's', runs, 10, 1)))
    const cuts = pieceCuts(runs, 64 * 1024)
    expect(cuts.length).toBeGreaterThan(3)
    expect([...cuts].sort(compareUtf8)).toEqual(cuts)
    const parts = []
    for (let piece = 0; piece <= cuts.length; piece++) {
      const range = { after: piece ? cuts[piece - 1]! : null, through: cuts[piece] ?? null }
      const out = await compactRuns(store, 's', runs, 11, 1, { range, partBase: piece * 1000 })
      parts.push(...out.parts)
    }
    const joined: RunIndex = { seq: 11, tier: 1, parts }
    expect(await collect(readRun(store, 's', joined))).toEqual(whole)
    expect(await collect(mergeRuns(store, 's', [joined]))).toEqual(
      await collect(mergeRuns(store, 's', runs)),
    )
  })
})

async function json(res: Response) {
  return (await res.json()) as any
}

/** Open a session, upload `batches`, commit, drain the jobs; the session's final status. */
async function push(h: Harness, user: string, base: string, batches: object[][], open = {}) {
  const sid = (
    await json(
      await h.request(`${base}/push`, {
        method: 'POST',
        user,
        json: { schemas: { Author }, ...open },
      }),
    )
  ).session_id as string
  for (const b of batches) {
    const r = await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: b })
    expect(r.status).toBe(200)
  }
  const commit = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  expect([201, 202, 422]).toContain(commit.status)
  await h.drain()
  return { sid, status: await json(await h.request(`${base}/push/${sid}`, { user })) }
}

async function headTree(h: Harness, collectionId: string) {
  const [c] = await h.ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  const [v] = await h.ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.id, c!.headVersionId!))
  const repo = await h.ports.stores.forCollection(collectionId)
  return { count: v!.recordCount, root: (await repo.root(v!.hash)).public.types.Author }
}

describe('one version from many uploads', () => {
  it('compacts down to the commit’s run limit, in pieces, then commits in planned chunks', async () => {
    const h = await harness()
    const user = await h.member()
    const a = await h.collection('many')
    const b = await h.collection('one')
    // 60 uploads, interleaved keys: every upload spans the whole key range.
    // Ids are split-key candidates (marks) every so often, so units can split.
    const ids: string[] = []
    for (let i = 0; ids.length < 2400; i++) {
      const id = `r${String(i).padStart(7, '0')}`
      if (isMark(id) || i % 97 === 0) ids.push(id)
    }
    const batches = Array.from({ length: 60 }, (_, j) =>
      Array.from({ length: 40 }, (_, i) => rec(ids[i * 60 + j]!, body(i))),
    )
    Object.assign(compactConfig, { commitRuns: 4, pieceBytes: 40_000 })
    Object.assign(parallelConfig, { aboveBytes: 0, unitBytes: 50_000, baseLevel: 0, chunkUnits: 2 })
    runConfig.partBytes = 16 * 1024
    const many = await push(h, user, '/api/collections/org/many', batches)
    expect(many.status).toMatchObject({ status: 'committed' })
    // Compaction ran in pieces and left at most four runs for the commit.
    const runs = await h.ports.db
      .select()
      .from(schema.pushRuns)
      .where(eq(schema.pushRuns.sessionId, many.sid))
    expect(runs.length).toBeLessThanOrEqual(4)
    const pieces = await h.ports.stores.internal.list(`sessions/${many.sid}/runs/`)
    expect(pieces.keys.some((k) => k.includes('/piece-'))).toBe(true)
    // The plan was written in several chunks.
    const units = await h.ports.db
      .select()
      .from(schema.commitUnits)
      .where(eq(schema.commitUnits.sessionId, many.sid))
    expect(units.filter((u) => !u.gap).length).toBeGreaterThan(4)

    // The same records in one upload, committed serially: the same tree.
    Object.assign(compactConfig, defaults.compact)
    Object.assign(parallelConfig, { aboveBytes: Infinity })
    const one = await push(h, user, '/api/collections/org/one', [batches.flat()])
    expect(one.status).toMatchObject({ status: 'committed' })
    expect(await headTree(h, a.id)).toEqual(await headTree(h, b.id))
    expect((await headTree(h, a.id)).count).toBe(2400)
  }, 60_000)

  it('says where a session is: its runs, then the commit’s phase and units', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('st')
    const path = '/api/collections/org/st'
    const sid = (
      await json(
        await h.request(`${path}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
      )
    ).session_id as string
    for (let j = 0; j < 6; j++)
      await h.request(`${path}/push/${sid}/records`, {
        method: 'POST',
        user,
        ndjson: Array.from({ length: 10 }, (_, i) => rec(`k${j}-${i}`, body(i))),
      })
    const status = async () => json(await h.request(`${path}/push/${sid}`, { user }))
    expect((await status()).progress).toMatchObject({ runs: 6, phase: null, units: null })
    // Runs hold the records, or on layout F their places in the uploads' packs.
    if (process.env.UNDERLAY_TEST_LAYOUT === 'f')
      expect((await status()).progress.run_bytes).toBeLessThan(6 * 10 * 512)
    else expect((await status()).progress.run_bytes).toBeGreaterThan(6 * 10 * 512)
    Object.assign(compactConfig, { commitRuns: 2 })
    const res = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
    // Too many runs for one commit: it compacts first, and answers 202.
    expect(res.status).toBe(202)
    expect((await status()).progress).toMatchObject({ phase: 'compacting' })
    expect((await status()).progress.runs_compacting).toBeGreaterThan(0)
    await h.drain()
    const done = await status()
    expect(done.status).toBe('committed')
    expect(done.progress).toBeUndefined()
  })
})
