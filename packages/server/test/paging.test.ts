import {
  type Change,
  compareUtf8,
  hashRecord,
  hashSchema,
  type RecordEntry,
  utf8ByteLength,
} from '@underlay/protocol'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { commitVersion, type TypeInput } from '../src/versions/commit.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const Doc = { type: 'object', properties: { n: { type: 'integer' } } }
const up = (id: string, n: number): Change<RecordEntry> => {
  const { hash, canonical } = hashRecord(id, 'Doc', { n })
  return { key: id, entry: { key: id, hash, size: utf8ByteLength(canonical), body: canonical } }
}
const del = (id: string): Change<RecordEntry> => ({ key: id, entry: null })
const byKey = (cs: Change<RecordEntry>[]) => cs.sort((a, b) => compareUtf8(a.key, b.key))
const doc = (pub: Change<RecordEntry>[], priv: Change<RecordEntry>[]): TypeInput => ({
  slug: 'Doc',
  schema: Doc,
  schemaHash: hashSchema(Doc),
  public: byKey(pub),
  private: byKey(priv),
})
const id = (i: number) => `d${String(i).padStart(4, '0')}`

describe('diff and manifest paging', () => {
  it('pages through a long diff to exactly the one-page answer', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('docs')
    const v1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [
        doc(
          Array.from({ length: 1200 }, (_, i) => up(id(i), 0)),
          Array.from({ length: 300 }, (_, i) => up(id(2000 + i), 0)),
        ),
      ],
      metadata: null,
    })
    if (v1.status !== 'committed') throw new Error(v1.status)
    // Updates, deletes, additions, and records moving between sets: 50 unchanged
    // (no change to a member) and 20 changed on the way.
    const pub: Change<RecordEntry>[] = []
    const priv: Change<RecordEntry>[] = []
    for (let i = 0; i < 500; i++) pub.push(up(id(i), 1))
    for (let i = 500; i < 600; i++) pub.push(del(id(i)))
    for (let i = 3000; i < 3200; i++) pub.push(up(id(i), 0))
    for (let i = 600; i < 670; i++) {
      pub.push(del(id(i)))
      priv.push(up(id(i), i < 650 ? 0 : 2))
    }
    const v = v1.version
    const v2 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: {
        id: v.id,
        seq: v.seq,
        semver: v.semver,
        hash: v.hash,
        publicRefsRoot: v.publicRefsRoot,
        privateRefsRoot: v.privateRefsRoot,
      },
      types: [doc(pub, priv)],
      metadata: null,
    })
    if (v2.status !== 'committed') throw new Error(v2.status)
    const base = `/api/collections/org/docs/versions/${v2.version.semver}`
    const get = async (path: string) => (await h.request(path, { user })).json()

    type DiffPage = {
      added: { id: string }[]
      updated: { id: string }[]
      removed: { id: string; type: string }[]
      pagination: { nextCursor: string | null }
    }
    const one = (await get(`${base}/diff?from=${v.semver}&limit=5000`)) as DiffPage
    const ids = (p: DiffPage) => ({
      added: p.added.map((x) => x.id),
      updated: p.updated.map((x) => x.id),
      removed: p.removed.map((x) => x.id),
    })
    expect(ids(one).added).toHaveLength(200)
    expect(ids(one).updated).toHaveLength(520)
    expect(ids(one).removed).toHaveLength(100)
    const paged = { added: [] as string[], updated: [] as string[], removed: [] as string[] }
    let cursor: string | null = null
    let pages = 0
    do {
      const p = (await get(
        `${base}/diff?from=${v.semver}&limit=97${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )) as DiffPage
      const x = ids(p)
      paged.added.push(...x.added)
      paged.updated.push(...x.updated)
      paged.removed.push(...x.removed)
      cursor = p.pagination.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(Math.ceil(820 / 97))
    expect(paged).toEqual(ids(one))

    type Entry = {
      id: string
      hash: string
      previousHash?: string
      private?: true
      previousPrivate?: boolean
    }
    type Manifest = {
      delta: { added: Entry[]; updated: Entry[]; removed: Entry[] }
      files: string[]
      pagination: { nextCursor: string | null }
    }
    const whole = (await get(`${base}/manifest?since=${v.semver}`)) as Manifest
    const lines: object[] = []
    cursor = null
    let first = true
    do {
      const p = (await get(
        `${base}/manifest?since=${v.semver}&limit=150${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )) as Manifest
      lines.push(...p.delta.added, ...p.delta.updated, ...p.delta.removed)
      if (!first) expect(p.files).toEqual([])
      first = false
      cursor = p.pagination.nextCursor
    } while (cursor)
    // The manifest also lists the 50 moves that kept their hash, as updates.
    expect(lines).toHaveLength(870)
    expect(new Set(lines.map((l) => JSON.stringify(l)))).toEqual(
      new Set(
        [...whole.delta.added, ...whole.delta.updated, ...whole.delta.removed].map((l) =>
          JSON.stringify(l),
        ),
      ),
    )
    expect(whole.delta.updated).toHaveLength(570)
    const moves = whole.delta.updated.filter((e) => e.previousPrivate !== undefined)
    expect(moves).toHaveLength(70)
    expect(moves.every((e) => e.private && e.previousPrivate === false)).toBe(true)
    expect(moves.filter((e) => e.hash === e.previousHash).map((e) => e.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => id(600 + i)),
    )
    // Private records say so; a public update carries neither flag.
    expect(whole.delta.updated.find((e) => e.id === id(0))).toEqual({
      id: id(0),
      type: 'Doc',
      hash: up(id(0), 1).entry!.hash,
      previousHash: up(id(0), 0).entry!.hash,
    })

    // A reader of the public set only sees the moves as removals.
    await h.ports.db.update(schema.collections).set({ public: true })
    const pubDiff = (await (
      await h.request(`${base}/diff?from=${v.semver}&limit=5000`)
    ).json()) as DiffPage
    expect(ids(pubDiff).removed).toHaveLength(170)
    expect(ids(pubDiff).updated).toHaveLength(500)
    const pubDelta = (await (
      await h.request(`${base}/manifest?since=${v.semver}`)
    ).json()) as Manifest
    expect(pubDelta.delta.removed).toHaveLength(170)
    expect(pubDelta.delta.updated).toHaveLength(500)
    const all = [...pubDelta.delta.added, ...pubDelta.delta.updated, ...pubDelta.delta.removed]
    expect(all.some((e) => e.private || e.previousPrivate !== undefined)).toBe(false)
  })
})
