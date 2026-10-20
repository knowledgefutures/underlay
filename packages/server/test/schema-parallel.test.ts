/**
 * Schema changes, privacy changes and type removals on the parallel path: each
 * commits the same version, with the same counts and file sets, as the serial
 * build, and a changed schema is revalidated in jobs. A change that can't reject
 * a record (schemaRelaxes) isn't revalidated at all.
 */
import { createHash } from 'node:crypto'

import { iterate, type RecordSet, RepoSource, recordTree } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { parallelConfig } from '../src/push/parallel.js'
import { isMark } from '../src/push/runs.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)
const defaults = { ...parallelConfig }
afterEach(() => Object.assign(parallelConfig, defaults))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Doc = {
  type: 'object',
  properties: { name: { type: 'string' }, pic: { type: 'object' } },
  required: ['name'],
}
const Note = { type: 'object', properties: { text: { type: 'string' } } }

/** Ids, some of them split-key candidates, so units split. */
function ids(prefix: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; out.length < n; i++) {
    const id = `${prefix}${String(i).padStart(6, '0')}`
    if (isMark(id) || i % 37 === 0) out.push(id)
  }
  return out
}
const doc = (id: string, name: string, extra: Record<string, unknown> = {}) => {
  const { pic, ...rest } = extra
  return {
    id,
    type: 'Doc',
    data: { name, ...(pic ? { pic: { $file: `sha256:${sha(String(pic))}` } } : {}) },
    ...rest,
  }
}

async function json(res: Response) {
  return (await res.json()) as any
}

type Mode = 'parallel' | 'serial'

/** One push, committed in `mode`; the session's final status. */
async function push(
  h: Harness,
  user: string,
  path: string,
  open: Record<string, unknown>,
  records: object[],
  mode: Mode,
  deletes: { type: string; id: string }[] = [],
) {
  Object.assign(
    parallelConfig,
    mode === 'parallel'
      ? { aboveBytes: 0, unitBytes: 4000, baseLevel: 0 }
      : { aboveBytes: Infinity },
  )
  const sid = (await json(await h.request(`${path}/push`, { method: 'POST', user, json: open })))
    .session_id as string
  if (records.length)
    expect(
      (await h.request(`${path}/push/${sid}/records`, { method: 'POST', user, ndjson: records }))
        .status,
    ).toBe(200)
  if (deletes.length)
    await h.request(`${path}/push/${sid}/deletes`, { method: 'POST', user, ndjson: deletes })
  await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
  await h.drain()
  const status = await json(await h.request(`${path}/push/${sid}`, { user }))
  const [row] = await h.ports.db
    .select()
    .from(schema.pushSessions)
    .where(eq(schema.pushSessions.id, sid))
  return { sid, status, parallel: row!.commitPlan !== null }
}

/** The head version's sets (salt-free parts) and counts. */
async function head(h: Harness, collectionId: string) {
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
  const priv = root.private ? await repo.privateSet(root.private) : null
  return {
    public: root.public,
    private: priv ? { types: priv.types, files: priv.files } : null,
    version: { recordCount: v!.recordCount, fileCount: v!.fileCount, changes: v!.changes },
  }
}

/** Keys the parallel commit wrote under a session's plans. */
async function planKeys(h: Harness, sid: string) {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await h.ports.stores.internal.list(`sessions/${sid}/commit/`, cursor)
    out.push(...page.keys)
    cursor = page.cursor
  } while (cursor)
  return out
}

/** Records of a tree read with their bodies from one set alone (layout F keeps them apart). */
async function readsFrom(
  h: Harness,
  collectionId: string,
  set: RecordSet,
  type: string,
  root: string | null,
) {
  const repo = await h.ports.stores.forCollection(collectionId)
  let n = 0
  for await (const e of iterate(new RepoSource(recordTree, repo, { set, type }), root, {
    payloads: true,
  }))
    if (e.body) n++
  return n
}

async function planOf(h: Harness, sid: string) {
  const key = (await planKeys(h, sid)).find((k) => k.endsWith('/plan.json'))!
  return JSON.parse(await (await h.ports.stores.internal.get(key))!.text()) as {
    types: Record<string, { move?: string; validate?: boolean }>
  }
}

/** Two collections with the same base: `a` gets the parallel commit, `b` the serial one. */
async function pair(name: string, base: { schemas: object; records: object[] }) {
  const h = await harness()
  const user = await h.member()
  const a = await h.collection(`${name}-a`)
  const b = await h.collection(`${name}-b`)
  const paths = { a: `/api/collections/org/${name}-a`, b: `/api/collections/org/${name}-b` }
  for (const path of [paths.a, paths.b]) {
    for (const f of ['f1', 'f2'])
      await h.request(`${path}/files/${sha(f)}`, { method: 'PUT', user, body: f })
    const r = await push(h, user, path, { schemas: base.schemas }, base.records, 'serial')
    expect(r.status.status).toBe('committed')
  }
  return { h, user, a, b, paths }
}

const baseDocs = () =>
  ids('d', 300).map((id, i) => doc(id, `name ${i}`, i % 50 === 0 ? { pic: 'f1' } : {}))

describe('schema and privacy changes in a parallel commit', () => {
  it('revalidates a changed schema in jobs, and builds what the serial commit builds', async () => {
    const { h, user, a, b, paths } = await pair('sch', {
      schemas: { Doc },
      records: baseDocs(),
    })
    const Doc2 = {
      ...Doc,
      properties: { ...Doc.properties, name: { type: 'string', maxLength: 20 } },
    }
    const changes = [
      ...ids('d', 300)
        .slice(0, 40)
        .map((id) => doc(id, 'renamed', { pic: 'f2' })),
      ...ids('e', 30).map((id) => doc(id, 'new')),
    ]
    const deletes = ids('d', 300)
      .slice(200, 205)
      .map((id) => ({ type: 'Doc', id }))
    const pa = await push(
      h,
      user,
      paths.a,
      { schemas: { Doc: Doc2 } },
      changes,
      'parallel',
      deletes,
    )
    const pb = await push(h, user, paths.b, { schemas: { Doc: Doc2 } }, changes, 'serial', deletes)
    expect(pa.status.status).toBe('committed')
    expect(pb.status.status).toBe('committed')
    expect(pa.parallel).toBe(true)
    expect((await planOf(h, pa.sid)).types.Doc!.validate).toBe(true)
    expect((await planKeys(h, pa.sid)).some((k) => k.includes('/validate/'))).toBe(true)
    expect(await head(h, a.id)).toEqual(await head(h, b.id))
  }, 30_000)

  it('fails a commit whose records don’t fit the new schema, as the serial commit does', async () => {
    const { h, user, paths } = await pair('bad', { schemas: { Doc }, records: baseDocs() })
    const Doc2 = {
      ...Doc,
      properties: { ...Doc.properties, name: { type: 'string', maxLength: 6 } },
    }
    const one = [doc('zz', 'ok')]
    const pa = await push(h, user, paths.a, { schemas: { Doc: Doc2 } }, one, 'parallel')
    const pb = await push(h, user, paths.b, { schemas: { Doc: Doc2 } }, one, 'serial')
    for (const p of [pa, pb]) {
      expect(p.status.status).toBe('failed')
      expect(p.status.error.error).toBe('Schema validation failed')
    }
    expect(pa.status.error.totalErrors).toBe(pb.status.error.totalErrors)
    expect(pa.status.error.totalErrors).toBeGreaterThan(200)
    expect(pa.status.error.validationErrors.length).toBe(100)
  }, 30_000)

  it('skips revalidation for a change that only relaxes the schema', async () => {
    const { h, user, a, b, paths } = await pair('rel', { schemas: { Doc }, records: baseDocs() })
    const looser = { ...Doc, required: [], description: 'Docs' }
    const changes = ids('d', 300)
      .slice(0, 60)
      .map((id) => doc(id, 'x'))
    const pa = await push(h, user, paths.a, { schemas: { Doc: looser } }, changes, 'parallel')
    const pb = await push(h, user, paths.b, { schemas: { Doc: looser } }, changes, 'serial')
    expect(pa.status.status).toBe('committed')
    expect(pa.parallel).toBe(true)
    expect((await planOf(h, pa.sid)).types.Doc!.validate).toBeUndefined()
    expect((await planKeys(h, pa.sid)).some((k) => k.includes('/validate'))).toBe(false)
    expect(pb.status.status).toBe('committed')
    expect(await head(h, a.id)).toEqual(await head(h, b.id))
  }, 30_000)

  it('makes a type private by moving its tree, as the serial commit does', async () => {
    const { h, user, a, b, paths } = await pair('priv', { schemas: { Doc }, records: baseDocs() })
    const PrivateDoc = { ...Doc, private: true }
    const changes = ids('d', 300)
      .slice(100, 160)
      .map((id) => doc(id, 'moved', { pic: 'f2' }))
    const pa = await push(h, user, paths.a, { schemas: { Doc: PrivateDoc } }, changes, 'parallel')
    const pb = await push(h, user, paths.b, { schemas: { Doc: PrivateDoc } }, changes, 'serial')
    expect(pa.status.status).toBe('committed')
    // Layout F copies a moved type's records into the other set's packs, in the serial build.
    if (a.recordLayout === 'today') {
      expect(pa.parallel).toBe(true)
      expect((await planOf(h, pa.sid)).types.Doc!.move).toBe('toPrivate')
    } else expect(pa.parallel).toBe(false)
    expect(pb.status.status).toBe('committed')
    const ha = await head(h, a.id)
    expect(ha).toEqual(await head(h, b.id))
    expect(ha.public.types.Doc).toBeUndefined()
    expect(ha.private?.types.Doc?.count).toBe(300)
    // Every record of the moved type reads from its new set alone.
    expect(await readsFrom(h, a.id, 'private', 'Doc', ha.private!.types.Doc!.root)).toBe(300)
  }, 30_000)

  it('makes a private type public by moving its tree, as the serial commit does', async () => {
    const PrivateDoc = { ...Doc, private: true }
    const { h, user, a, b, paths } = await pair('pub', {
      schemas: { Doc: PrivateDoc },
      records: baseDocs(),
    })
    const changes = ids('e', 40).map((id) => doc(id, 'public', { pic: 'f2' }))
    const pa = await push(h, user, paths.a, { schemas: { Doc } }, changes, 'parallel')
    const pb = await push(h, user, paths.b, { schemas: { Doc } }, changes, 'serial')
    expect(pa.status.status).toBe('committed')
    if (a.recordLayout === 'today') {
      expect(pa.parallel).toBe(true)
      expect((await planOf(h, pa.sid)).types.Doc!.move).toBe('toPublic')
    } else expect(pa.parallel).toBe(false)
    expect(pb.status.status).toBe('committed')
    expect(pa.status.result.changes).toEqual(pb.status.result.changes)
    const ha = await head(h, a.id)
    expect(await readsFrom(h, a.id, 'public', 'Doc', ha.public.types.Doc!.root)).toBe(
      ha.public.types.Doc!.count,
    )
    expect(ha).toEqual(await head(h, b.id))
    expect(ha.public.types.Doc?.count).toBe(340)
  }, 30_000)

  it('keeps a type turning public with private records in the push serial', async () => {
    const PrivateDoc = { ...Doc, private: true }
    const { h, user, paths } = await pair('mixed', {
      schemas: { Doc: PrivateDoc },
      records: baseDocs().slice(0, 40),
    })
    const changes = [doc('k1', 'secret', { private: true }), doc('k2', 'open')]
    const pa = await push(h, user, paths.a, { schemas: { Doc } }, changes, 'parallel')
    expect(pa.status.status).toBe('committed')
    expect(pa.parallel).toBe(false)
  })

  it('removes a type, as the serial commit does', async () => {
    const records = [
      ...baseDocs(),
      ...ids('n', 50).map((id) => ({ id, type: 'Note', data: { text: id } })),
    ]
    const { h, user, a, b, paths } = await pair('rm', { schemas: { Doc, Note }, records })
    const changes = ids('d', 300)
      .slice(0, 30)
      .map((id) => doc(id, 'kept'))
    const pa = await push(h, user, paths.a, { schemas: { Doc } }, changes, 'parallel')
    const pb = await push(h, user, paths.b, { schemas: { Doc } }, changes, 'serial')
    expect(pa.status.status).toBe('committed')
    expect(pa.parallel).toBe(true)
    expect(pb.status.status).toBe('committed')
    const ha = await head(h, a.id)
    expect(ha).toEqual(await head(h, b.id))
    expect(ha.public.types.Note).toBeUndefined()
  }, 30_000)

  it('counts revalidation as work: a small push that revalidates a large type goes parallel', async () => {
    const { h, user, paths } = await pair('small', { schemas: { Doc }, records: baseDocs() })
    const Doc2 = {
      ...Doc,
      properties: { ...Doc.properties, name: { type: 'string', maxLength: 50 } },
    }
    // Above the one record's bytes, below the type's.
    Object.assign(parallelConfig, { aboveBytes: 2000 })
    const sid = (
      await json(
        await h.request(`${paths.a}/push`, {
          method: 'POST',
          user,
          json: { schemas: { Doc: Doc2 } },
        }),
      )
    ).session_id as string
    await h.request(`${paths.a}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [doc('q', 'q')],
    })
    Object.assign(parallelConfig, { unitBytes: 4000, baseLevel: 0 })
    const res = await h.request(`${paths.a}/push/${sid}/commit`, { method: 'POST', user })
    expect(res.status).toBe(202)
    await h.drain()
    const status = await json(await h.request(`${paths.a}/push/${sid}`, { user }))
    expect(status.status).toBe('committed')
    expect((await planOf(h, sid)).types.Doc!.validate).toBe(true)
  })
})
