/**
 * Layout F uploads write their records straight into the collection's packs
 * (push/packs.ts): runs carry places instead of bodies, a commit indexes the
 * records without writing them again, its packs are listed once before the version
 * publishes, and cleanup deletes the packs of a push that never did.
 */
import { createHash } from 'node:crypto'

import {
  countTree,
  iterate,
  layoutConfig,
  type RecordSet,
  RepoSource,
  recordTree,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { cleanupConfig, getRun } from '../src/cleanup/config.js'
import { startRun } from '../src/cleanup/runs.js'
import * as schema from '../src/db/schema.js'
import { compactConfig } from '../src/push/compact.js'
import { parallelConfig } from '../src/push/parallel.js'
import { mergeRuns, type RunEntry } from '../src/push/runs.js'
import { sessionRuns } from '../src/push/session.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const defaults = { parallel: { ...parallelConfig }, compact: { ...compactConfig } }
afterEach(() => {
  Object.assign(parallelConfig, defaults.parallel)
  Object.assign(compactConfig, defaults.compact)
})

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: { type: 'object' } } }
const doc = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'Doc',
  data: { title, ...extra },
})
const id = (i: number) => `d${String(i).padStart(5, '0')}`
const DAY = 24 * 60 * 60 * 1000

async function json(res: Response) {
  return (await res.json()) as any
}

async function open(h: Harness, user: string, slug: string, extra: object = {}) {
  const res = await h.request(`/api/collections/org/${slug}/push`, {
    method: 'POST',
    user,
    json: { schemas: { Doc }, ...extra },
  })
  expect(res.status).toBe(200)
  return (await json(res)).session_id as string
}

async function status(h: Harness, user: string, slug: string, sid: string) {
  return json(await h.request(`/api/collections/org/${slug}/push/${sid}`, { user }))
}

async function upload(h: Harness, user: string, slug: string, sid: string, batch: object[]) {
  const r = await h.request(`/api/collections/org/${slug}/push/${sid}/records`, {
    method: 'POST',
    user,
    ndjson: batch,
  })
  expect(r.status).toBe(200)
}

async function commit(h: Harness, user: string, slug: string, sid: string) {
  const res = await h.request(`/api/collections/org/${slug}/push/${sid}/commit`, {
    method: 'POST',
    user,
  })
  await h.drain()
  return res.status
}

/** Pack files of a collection's set in the bucket. */
const packKeys = (h: Harness, collectionId: string, set: RecordSet = 'public') =>
  [...h.bucket.objects.keys()].filter((k) =>
    k.startsWith(`repo/runs/${collectionId}/${set}/packs/`),
  )

/** Every record of the head version: `set id title`. */
async function headRecords(h: Harness, collectionId: string) {
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
  const sets: [RecordSet, string | null][] = [['public', root.public.types.Doc?.root ?? null]]
  if (root.private)
    sets.push(['private', (await repo.privateSet(root.private)).types.Doc?.root ?? null])
  for (const [set, tree] of sets)
    for await (const e of iterate(new RepoSource(recordTree, repo, { set, type: 'Doc' }), tree, {
      payloads: true,
    })) {
      const body = JSON.parse(e.body!) as { data: { title: string } }
      out.push(`${set} ${e.key} ${body.data.title}`)
    }
  return { v: v!, out }
}

async function sessionEntries(h: Harness, sid: string) {
  const out: RunEntry[] = []
  for await (const e of mergeRuns(h.ports.stores.internal, sid, await sessionRuns(h.ports, sid)))
    out.push(e)
  return out
}

describe.runIf(process.env.UNDERLAY_TEST_LAYOUT === 'f')('uploads into layout F', () => {
  it('write records into packs once, and runs carry places, not bodies', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('a', { recordLayout: 'f' })
    const sid = await open(h, user, 'a')
    const title = 't'.repeat(2000)
    // The last of a key in a batch wins: only it goes in a pack.
    await upload(h, user, 'a', sid, [
      ...Array.from({ length: 300 }, (_, i) => doc(id(i), `${title}${i}`)),
      doc(id(0), 'replaced'),
    ])
    const packs = packKeys(h, c.id)
    // A pack is its blocks and their directory.
    expect(packs).toHaveLength(2)
    const entries = await sessionEntries(h, sid)
    expect(entries).toHaveLength(300)
    expect(entries.every((e) => e.b === undefined && typeof e.l === 'string')).toBe(true)
    // The run holds places: a small part of the records' bytes.
    const [run] = await h.ports.db
      .select()
      .from(schema.pushRuns)
      .where(eq(schema.pushRuns.sessionId, sid))
    expect(run!.bytes).toBeLessThan((300 * title.length) / 10)
    const rows = await h.ports.db
      .select()
      .from(schema.pushPacks)
      .where(eq(schema.pushPacks.sessionId, sid))
    const written = rows.filter((r) => r.records !== null)
    expect(written).toHaveLength(1)
    expect(written[0]!.records).toBe(300)
    // Its type, so a merge once it's listed takes it with its own type's packs.
    expect(written[0]!.recordType).toBe('Doc')

    // The commit indexes them where they are: no record is written again.
    expect(await commit(h, user, 'a', sid)).toBe(201)
    expect(packKeys(h, c.id)).toEqual(packs)
    const { out } = await headRecords(h, c.id)
    expect(out).toHaveLength(300)
    expect(out[0]).toBe(`public ${id(0)} replaced`)
    expect(out[299]).toBe(`public ${id(299)} ${title}299`)
  })

  it('keep large records in packs, without staging them apart', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('big', { recordLayout: 'f' })
    const sid = await open(h, user, 'big')
    const big = doc('big', 'x'.repeat(70_000))
    await upload(h, user, 'big', sid, [big, doc('small', 's')])
    const staged = [...h.bucket.objects.keys()].filter((k) =>
      k.startsWith(`internal/sessions/${sid}/records/`),
    )
    expect(staged).toEqual([])
    expect(await commit(h, user, 'big', sid)).toBe(201)
    expect([...h.bucket.objects.keys()].filter((k) => k.startsWith('repo/records/'))).toEqual([])
    const { out } = await headRecords(h, c.id)
    expect(out).toEqual([`public big ${'x'.repeat(70_000)}`, 'public small s'])
  })

  it('put private records in the private set’s packs', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('p', { recordLayout: 'f' })
    const sid = await open(h, user, 'p')
    await upload(h, user, 'p', sid, [
      doc('pub', 'open'),
      { ...doc('priv', 'hidden'), private: true },
    ])
    expect(packKeys(h, c.id, 'public')).toHaveLength(2)
    expect(packKeys(h, c.id, 'private')).toHaveLength(2)
    expect(await commit(h, user, 'p', sid)).toBe(201)
    expect((await headRecords(h, c.id)).out).toEqual(['public pub open', 'private priv hidden'])
  })

  it('count the files records reference, read at upload', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('files', { recordLayout: 'f' })
    const file = 'the pdf'
    const withFile = doc('d1', 'has a file', { pdf: { $file: `sha256:${sha(file)}` } })
    // Not uploaded: the commit refuses, so it saw the reference.
    const missing = await open(h, user, 'files')
    await upload(h, user, 'files', missing, [withFile])
    expect(await commit(h, user, 'files', missing)).toBe(422)

    const put = await h.request(`/api/collections/org/files/files/${sha(file)}`, {
      method: 'PUT',
      user,
      body: file,
    })
    expect(put.status).toBeLessThan(300)
    const sid = await open(h, user, 'files')
    await upload(h, user, 'files', sid, [withFile])
    expect(await commit(h, user, 'files', sid)).toBe(201)
    // The version's file references: the record's file, from the run entry alone.
    const { v } = await headRecords(h, c.id)
    expect(v.publicRefsRoot).not.toBeNull()
    const repo = await h.ports.stores.forCollection(c.id)
    const refs: string[] = []
    for await (const e of iterate(new RepoSource(countTree, repo), v.publicRefsRoot))
      refs.push(`${e.key} ${e.n}`)
    expect(refs.some((r) => r.includes(sha(file)) && r.endsWith(' 1'))).toBe(true)
  })

  it('commit in parallel after compaction, the same versions as today’s layout', async () => {
    const h = await harness()
    const user = await h.member()
    const today = await h.collection('today', { recordLayout: 'today' })
    const f = await h.collection('f', { recordLayout: 'f' })
    await h.ports.db
      .update(schema.collections)
      .set({ privateSalt: today.privateSalt })
      .where(eq(schema.collections.id, f.id))
    // Six uploads into a collection with a base: compacted, then committed in units.
    const batches = Array.from({ length: 6 }, (_, j) =>
      Array.from({ length: 200 }, (_, i) => {
        const n = (j * 7919 + i * 104_729) % 2000
        return doc(id(n), `v${j}-${n}`)
      }),
    )
    for (const slug of ['today', 'f']) {
      const first = await open(h, user, slug)
      await upload(h, user, slug, first, [doc(id(0), 'base'), doc(id(5000), 'kept')])
      expect(await commit(h, user, slug, first)).toBe(201)
      Object.assign(compactConfig, { commitRuns: 2 })
      Object.assign(parallelConfig, { aboveBytes: 0, unitBytes: 32_000, baseLevel: 0 })
      const sid = await open(h, user, slug)
      for (const b of batches) await upload(h, user, slug, sid, b)
      const before = packKeys(h, f.id).length
      expect(await commit(h, user, slug, sid)).toBe(202)
      const [s] = await h.ports.db
        .select()
        .from(schema.pushSessions)
        .where(eq(schema.pushSessions.id, sid))
      expect(s!.status).toBe('committed')
      // F's units wrote no pack: every record was in one already.
      if (slug === 'f') expect(packKeys(h, f.id).length).toBe(before)
      Object.assign(compactConfig, defaults.compact)
      Object.assign(parallelConfig, defaults.parallel)
    }
    const a = await headRecords(h, today.id)
    const b = await headRecords(h, f.id)
    expect(b.v.hash).toBe(a.v.hash)
    expect(b.out).toEqual(a.out)
  })

  it('are listed once in the registry, and merged when small', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('l', { recordLayout: 'f' })
    // A batch past UPLOAD_PACK_FINAL_RAW: listed in the registry, never merged.
    const sid = await open(h, user, 'l')
    await upload(
      h,
      user,
      'l',
      sid,
      Array.from({ length: 600 }, (_, i) => doc(id(i), `${'y'.repeat(2000)}${i}`)),
    )
    expect(await commit(h, user, 'l', sid)).toBe(201)
    const registry = `repo/runs/${c.id}/public/manifest/f/packs/upload-${sid}.json`
    // Leveled, the first load (into an empty collection, none of its packs overlapping)
    // is the bottom level instead, as written.
    expect(h.bucket.objects.has(registry)).toBe(!layoutConfig.levelNew)
    const repo = await h.ports.stores.forCollection(c.id)
    const layout = repo.records!.public as unknown as {
      manifests: {
        latest(): Promise<{
          packs: { id: string; tier: number; type?: string }[]
          levels?: Record<string, { id: string }[]>
        }>
      }
      levels: { packs(s: { id: string }[]): Promise<{ lo?: string; hi?: string }[]> }
    }
    if (layoutConfig.levelNew) {
      const bottom = (await layout.manifests.latest()).levels?.[6]
      expect(bottom).toHaveLength(1)
      // Its key range whole, NULs and all, through the database.
      const [p] = await layout.levels.packs(bottom!)
      expect([p!.lo!.split('\u0000').slice(0, 2), p!.hi!.split('\u0000').slice(0, 2)]).toEqual([
        ['Doc', id(0)],
        ['Doc', id(599)],
      ])
    }
    // Small pushes: their packs go in the manifest, and merges re-point their records.
    for (let j = 0; j < 10; j++) {
      const s = await open(h, user, 'l')
      await upload(h, user, 'l', s, [doc(id(1000 + j), `small${j}`), doc(id(j), `changed${j}`)])
      expect(await commit(h, user, 'l', s)).toBe(201)
    }
    const { out } = await headRecords(h, c.id)
    expect(out).toHaveLength(610)
    expect(out.filter((r) => /changed|small/.test(r))).toHaveLength(20)
    const m = await layout.manifests.latest()
    // Every small pack listed, or merged into one above them (leveled: all ten in level
    // 0, under its 16-pack trigger), and each says its type.
    if (layoutConfig.levelNew) expect(m.packs).toHaveLength(10)
    else expect(m.packs.some((p) => p.tier > 0) || m.packs.length >= 10).toBe(true)
    expect(m.packs.every((p) => p.type === 'Doc')).toBe(true)
    expect(new Set(m.packs.map((p) => p.id)).size).toBe(m.packs.length)
  })

  it('of a push that never publishes are deleted by cleanup; a published one’s are kept', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('gone', { recordLayout: 'f' })
    const kept = await open(h, user, 'gone')
    await upload(h, user, 'gone', kept, [doc('k', 'kept')])
    expect(await commit(h, user, 'gone', kept)).toBe(201)
    const keptPacks = packKeys(h, c.id)
    expect(keptPacks).toHaveLength(2)

    const sid = await open(h, user, 'gone')
    await upload(h, user, 'gone', sid, [doc('x', 'abandoned')])
    expect(packKeys(h, c.id)).toHaveLength(4)
    const abort = await h.request(`/api/collections/org/gone/push/${sid}`, {
      method: 'DELETE',
      user,
    })
    expect(abort.status).toBeLessThan(300)
    // Past their sessions' grace.
    await h.ports.db
      .update(schema.pushSessions)
      .set({ expiresAt: new Date(Date.now() - cleanupConfig.sessionGraceMs - DAY) })
    const dry = await startRun(h.ports, 'internal', { trigger: 'manual', dryRun: true })
    await h.drain()
    expect((await getRun(h.ports.db, dry.id))!.stats!.deleted['upload packs']).toMatchObject({
      objects: 2,
    })
    expect(packKeys(h, c.id)).toHaveLength(4)

    const r = await startRun(h.ports, 'internal', { trigger: 'manual' })
    await h.drain()
    expect((await getRun(h.ports.db, r.id))!.status).toBe('done')
    expect(packKeys(h, c.id).sort()).toEqual(keptPacks.sort())
    expect(await h.ports.db.select().from(schema.pushPacks)).toEqual([])
    expect((await headRecords(h, c.id)).out).toEqual(['public k kept'])
  })

  it('of a push whose commit started and never published are listed, not deleted', async () => {
    // The failed commit may have indexed their records (the same record as the head's,
    // say, whose newest place is then in such a pack): deleting them could break reads.
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('half', { recordLayout: 'f' })
    const first = await open(h, user, 'half')
    await upload(h, user, 'half', first, [doc('same', 'unchanged')])
    expect(await commit(h, user, 'half', first)).toBe(201)

    const sid = await open(h, user, 'half')
    const file = { pdf: { $file: `sha256:${sha('never uploaded')}` } }
    await upload(h, user, 'half', sid, [doc('same', 'unchanged'), doc('new', 'needs a file', file)])
    // Refused for the missing file: the session is open again, then abandoned.
    expect(await commit(h, user, 'half', sid)).toBe(422)
    const abort = await h.request(`/api/collections/org/half/push/${sid}`, {
      method: 'DELETE',
      user,
    })
    expect(abort.status).toBeLessThan(300)
    const packs = packKeys(h, c.id)
    await h.ports.db
      .update(schema.pushSessions)
      .set({ expiresAt: new Date(Date.now() - cleanupConfig.sessionGraceMs - DAY) })
    const r = await startRun(h.ports, 'internal', { trigger: 'manual' })
    await h.drain()
    expect((await getRun(h.ports.db, r.id))!.status).toBe('done')
    expect(packKeys(h, c.id)).toEqual(packs)
    expect(await h.ports.db.select().from(schema.pushPacks)).toEqual([])
    // Listed with the collection's packs, for reclaim.
    const repo = await h.ports.stores.forCollection(c.id)
    const layout = repo.records!.public as unknown as {
      manifests: { latest(): Promise<{ adopted?: string[] }> }
    }
    expect((await layout.manifests.latest()).adopted).toContain(sid)
    expect((await headRecords(h, c.id)).out).toEqual(['public same unchanged'])
  })
  describe('in key order', () => {
    // A batch's records by id, from `from`; ids sort as their numbers do.
    const sorted = (from: number, n: number, title = 'r') =>
      Array.from({ length: n }, (_, i) => doc(id(from + i), `${title}${from + i}`))

    it('stream into whole packs, take larger batches, and count no overlaps', async () => {
      const h = await harness()
      const user = await h.member()
      const c = await h.collection('k', { recordLayout: 'f' })
      const res = await h.request('/api/collections/org/k/push', {
        method: 'POST',
        user,
        json: { schemas: { Doc }, in_key_order: true },
      })
      const opened = await json(res)
      expect(opened.in_key_order).toBe(true)
      expect(opened.limits).toMatchObject({ batch_bytes: 64 * 1024 * 1024, batch_lines: 50_000 })
      const sid = opened.session_id as string
      // One batch over the default 8 MB: a single pack, its records together.
      const big = (from: number) =>
        Array.from({ length: 1100 }, (_, i) => doc(id(from + i), `${'z'.repeat(8000)}${from + i}`))
      await upload(h, user, 'k', sid, big(0))
      expect(packKeys(h, c.id)).toHaveLength(2)
      await upload(h, user, 'k', sid, sorted(5000, 50))
      expect((await status(h, user, 'k', sid)).overlapping_uploads).toBe(0)
      expect(await commit(h, user, 'k', sid)).toBe(201)
      const { out } = await headRecords(h, c.id)
      expect(out).toHaveLength(1150)
      expect(out[1100]).toBe(`public ${id(5000)} r5000`)
    })

    it('refuse a batch out of order, and cleanup deletes what it packed', async () => {
      const h = await harness()
      const user = await h.member()
      const c = await h.collection('o', { recordLayout: 'f' })
      const sid = await open(h, user, 'o', { in_key_order: true })
      const batch = [...sorted(0, 300), doc(id(10), 'behind')]
      const r = await h.request(`/api/collections/org/o/push/${sid}/records`, {
        method: 'POST',
        user,
        ndjson: batch,
      })
      expect(r.status).toBe(422)
      expect((await json(r)).error).toMatch(/out of key order at line 301/)
      // What it packed before the refusal is reported, for cleanup.
      const rows = await h.ports.db
        .select()
        .from(schema.pushPacks)
        .where(eq(schema.pushPacks.sessionId, sid))
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.records !== null)).toBe(true)
      expect((await status(h, user, 'o', sid)).records_received).toBe(0)
      await h.request(`/api/collections/org/o/push/${sid}`, { method: 'DELETE', user })
      await h.ports.db
        .update(schema.pushSessions)
        .set({ expiresAt: new Date(Date.now() - cleanupConfig.sessionGraceMs - DAY) })
      await startRun(h.ports, 'internal', { trigger: 'manual' })
      await h.drain()
      expect(packKeys(h, c.id)).toEqual([])
    })

    it('is counted when uploads overlap, and ignored on today’s layout', async () => {
      const h = await harness()
      const user = await h.member()
      await h.collection('ov', { recordLayout: 'f' })
      const sid = await open(h, user, 'ov')
      await upload(h, user, 'ov', sid, sorted(0, 100))
      await upload(h, user, 'ov', sid, sorted(200, 100))
      expect((await status(h, user, 'ov', sid)).overlapping_uploads).toBe(0)
      // Ids 50–149: inside the first upload's range.
      await upload(h, user, 'ov', sid, sorted(50, 100))
      expect((await status(h, user, 'ov', sid)).overlapping_uploads).toBe(1)

      await h.collection('t', { recordLayout: 'today' })
      const res = await h.request('/api/collections/org/t/push', {
        method: 'POST',
        user,
        json: { schemas: { Doc }, in_key_order: true },
      })
      const opened = await json(res)
      expect(opened.in_key_order).toBe(false)
      expect(opened.limits.batch_bytes).toBe(8 * 1024 * 1024)
    })
  })
})
