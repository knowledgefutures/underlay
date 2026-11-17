/** Versions saved here, pushed unchanged, pulled on another machine, and replayed after a race. */
import { v3 } from '@underlay/protocol'
import { describe, expect, it } from 'vitest'

import { addCollection, forget, keep, newCollection } from '../src/core/collections.js'
import { type Coll, openColl } from '../src/core/context.js'
import { pull, push, pushPlan, StaleError } from '../src/core/sync.js'
import {
  headOf,
  logOf,
  reword,
  saveVersion,
  squash,
  undo,
  unpushedOf,
} from '../src/core/versions.js'
import { world } from './world.js'

const Person = {
  type: 'object',
  properties: { name: { type: 'string' }, unit: { type: 'string' } },
  required: ['name'],
}

const people = (...names: string[]) =>
  names.map((n) => v3.rowFromRecord(n.toLowerCase(), 'Person', { name: n, unit: 'CSAIL' }))

async function save(
  c: Coll,
  schemas: Record<string, unknown>,
  rows: v3.LineRow[],
  message = 'run',
) {
  return saveVersion(c, { rows, mode: 'set', schemas, message, now: new Date() })
}

describe('versions here, push and pull', () => {
  it('saves versions from whole sets, pushes them unchanged, and another machine pulls them', async () => {
    const w = await world()
    const meta = newCollection(w.ctx, 'test/org/staff', { title: 'People' })
    w.ws.writeSchemas(meta, { Person })
    const a = openColl(w.ctx, meta)

    const one = await save(a, { Person }, people('Ada', 'Grace'))
    expect(one.version?.commit).toMatchObject({ number: 1, semver: 'v1.0.0' })
    expect(one.stats).toMatchObject({ added: 2, changed: 0, removed: 0, schemas: 1 })
    // The same set again changes nothing.
    expect((await save(a, { Person }, people('Grace', 'Ada'))).version).toBeNull()
    const two = await save(a, { Person }, [
      ...people('Ada', 'Linus'),
      v3.rowFromRecord('grace', 'Person', { name: 'Grace H.', unit: 'CSAIL' }),
    ])
    expect(two.version?.commit.semver).toBe('v1.1.0')
    expect(two.stats).toMatchObject({ added: 1, changed: 1, removed: 0 })
    const three = await save(a, { Person }, people('Ada', 'Linus'))
    expect(three.stats).toMatchObject({ removed: 1 })

    // A record its schema refuses is not saved.
    await expect(
      save(a, { Person }, [v3.rowFromRecord('x', 'Person', { unit: 'no name' })]),
    ).rejects.toThrow(/not saved/)

    const plan = await pushPlan(a)
    expect(plan).toMatchObject({ isNew: true, from: null, access: 'private' })
    expect(plan!.versions.map((v) => v.semver)).toEqual(['v1.0.0', 'v1.1.0', 'v1.2.0'])
    const pushed = await push(w.ctx, a)
    expect(pushed.map((s) => s.id)).toEqual((await logOf(a)).map((s) => s.id))
    // The authority holds the same versions, with receipts.
    const theirs = await v3.findHead(w.h.ports.stores.v3, meta.id)
    expect(theirs?.id).toBe(three.version!.id)
    expect(await v3.readReceipt(a.store.fs, meta.id, 3)).toMatchObject({ version: theirs!.id })
    expect(await unpushedOf(a)).toEqual([])
    expect(w.ws.collection(meta).isNew).toBe(false)

    // Another machine adds it: the same ids, the files, the schemas.
    const m = w.machine()
    const { coll: b } = await addCollection(m.ctx, 'test/org/staff')
    expect((await logOf(b)).map((s) => s.id)).toEqual(pushed.map((s) => s.id))
    expect(m.ws.schemas(b.meta)).toEqual({ Person })
    const view = await v3.openView(b.store.fs, meta.id)
    const ids = []
    for await (const r of v3.exportAll(b.store.fs, view, { type: 'Person' })) ids.push(r.id)
    expect(ids).toEqual(['ada', 'linus'])
    expect(b.meta.keep).toBe('all')

    // Forget lets the files go; reading fetches them again.
    expect(await forget(m.ctx, b)).toBeGreaterThan(0)
    const b2 = openColl(m.ctx, m.ws.collection(b.meta))
    const again = []
    for await (const r of v3.exportAll(b2.data, await v3.openView(b2.data, meta.id), {
      type: 'Person',
    }))
      again.push(r.id)
    expect(again).toEqual(['ada', 'linus'])
    expect(await keep(m.ctx, b2)).toBe(0)
  })

  it('replays versions here on top when someone pushed first, and pushes them renumbered', async () => {
    const w = await world()
    const meta = newCollection(w.ctx, 'test/org/race')
    w.ws.writeSchemas(meta, { Person })
    const a = openColl(w.ctx, meta)
    await save(a, { Person }, people('Ada'))
    await push(w.ctx, a)

    const m = w.machine()
    const { coll: b } = await addCollection(m.ctx, 'test/org/race')
    await save(b, { Person }, people('Ada', 'Bob'), 'theirs')
    await push(m.ctx, b)

    // A saved its own version 2 meanwhile.
    const mine = await save(a, { Person }, people('Ada', 'Cy'), 'mine')
    expect(mine.version?.commit.number).toBe(2)
    const err = await push(w.ctx, a).catch((e) => e)
    expect(err).toBeInstanceOf(StaleError)
    expect(err.message).toMatch(/v1\.1\.0 \(2\) → v1\.2\.0 \(3\)/)
    const replayed = await unpushedOf(a)
    expect(replayed.map((s) => [s.commit.number, s.commit.changes[0]!.message])).toEqual([
      [3, 'mine'],
    ])
    // Its note (and change id) moved with it.
    expect(a.store.state(meta.id).versions[replayed[0]!.id]?.message).toBe('mine')
    await push(w.ctx, a)
    expect((await v3.findHead(w.h.ports.stores.v3, meta.id))?.id).toBe(replayed[0]!.id)
    // Last writer's rows stand: Cy added, and Bob kept (replayed rows add, they don't remove).
    await pull(m.ctx, b)
    const names = []
    const bv = await v3.openView(b.store.fs, meta.id)
    for await (const r of v3.exportAll(b.store.fs, bv, { type: 'Person' })) names.push(r.id)
    expect(names).toEqual(['ada', 'bob', 'cy'])
  })

  it('undoes, rewords and squashes versions not yet pushed, never pushed ones', async () => {
    const w = await world()
    const meta = newCollection(w.ctx, 'test/org/edits')
    w.ws.writeSchemas(meta, { Person })
    const a = openColl(w.ctx, meta)
    await save(a, { Person }, people('Ada'), 'one')
    await push(w.ctx, a)
    await save(a, { Person }, people('Ada', 'Bob'), 'two')
    await save(
      a,
      { Person },
      [
        ...people('Ada', 'Bob'),
        v3.rowFromRecord('em', 'Person', { name: 'Em', email: 'x' } as never),
      ],
      'three',
    )
    await save(a, { Person }, people('Ada', 'Bob', 'Cy'), 'four')
    expect((await unpushedOf(a)).map((s) => s.commit.semver)).toEqual([
      'v1.1.0',
      'v1.2.0',
      'v1.3.0',
    ])

    const re = await reword(a, 3, 'three, reworded', new Date())
    const after = await unpushedOf(a)
    expect(after.map((s) => s.commit.changes[0]!.message)).toEqual([
      'two',
      'three, reworded',
      'four',
    ])
    expect(after[2]!.commit.previous).toBe(re.id)
    expect(after[2]!.commit.changes[0]!.base).toBe(re.id)

    const sq = await squash(a, undefined, 'all of it', new Date())
    expect(sq?.commit).toMatchObject({ number: 2, semver: 'v1.1.0' })
    // The squashed version holds only the end state: Em came and went, and is not in it.
    const keys = v3.commitFiles(sq!.commit).flatMap((f) => [f.first?.[1], f.last?.[1]])
    expect(keys).not.toContain('em')
    expect(a.store.state(meta.id).versions[sq!.id]?.stats).toMatchObject({ added: 3, removed: 1 })

    const dropped = await undo(a)
    expect(dropped.id).toBe(sq!.id)
    expect((await headOf(a))?.commit.number).toBe(1)
    await expect(undo(a)).rejects.toThrow(/no versions that are not pushed/)
  })
})
