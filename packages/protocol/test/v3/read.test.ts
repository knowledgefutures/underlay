/** Reading: the engine against the model, at every version, with no layout. */
import { describe, expect, it } from 'vitest'

import { memoryStore, v3 } from '../../src/index.js'
import { dec, rec, rem, rng } from './helpers.js'
import { checkReads, commitRows, Model, randomUpload } from './model.js'

const line = (r: v3.WriteRow): v3.LineRow => {
  if (r.kind === 'w') throw new Error('no line')
  return { kind: r.kind, type: r.type, id: r.id, line: r.line as string }
}

describe('reading against the model', () => {
  it('agrees on every read at every version (random uploads)', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rand = rng(seed)
      const store = memoryStore()
      const model = new Model()
      const commits = 3 + Math.floor(rand() * 8)
      for (let c = 0; c < commits; c++) {
        const rows = randomUpload(rand)
        model.add(rows)
        // Sometimes cut an upload into several files.
        await commitRows(store, 'c', rows, rand() < 0.4 ? { maxBytes: 300 } : {})
      }
      await checkReads(store, 'c', model, rand)
    }
  }, 120_000)

  it('agrees across several key blocks, record blocks, and files', async () => {
    const rand = rng(99)
    const store = memoryStore()
    const model = new Model()
    const pad = (i: number) => String(i).padStart(5, '0')
    const base = Array.from({ length: 5000 }, (_, i) =>
      line(rec('work', pad(i), { i, text: 'x'.repeat(200 + (i % 7) * 30) })),
    )
    model.add(base)
    await commitRows(store, 'big', base, { maxBytes: 400_000 })
    for (let c = 0; c < 4; c++) {
      const rows = new Map<string, v3.LineRow>()
      for (let j = 0; j < 300; j++) {
        const i = Math.floor(rand() * 5200)
        rows.set(
          pad(i),
          line(
            rand() < 0.15 ? rem('work', pad(i)) : rec('work', pad(i), { i, c, t: 'y'.repeat(900) }),
          ),
        )
      }
      const sorted = [...rows.values()].sort(v3.compareKey)
      model.add(sorted)
      await commitRows(store, 'big', sorted)
    }
    const view = await v3.openView(store, 'big')
    expect(view.files.length).toBeGreaterThan(6)
    const keys = Array.from({ length: 60 }, () => ({
      type: 'work',
      id: pad(Math.floor(rand() * 5200)),
    }))
    await checkReads(store, 'big', model, rand, { keys })
  }, 120_000)
})

describe('views', () => {
  it('reads the newest version by default, and refuses one that does not exist', async () => {
    const store = memoryStore()
    await commitRows(store, 'c', [line(rec('t', 'a', 1))])
    await commitRows(store, 'c', [line(rec('t', 'a', 2))])
    const view = await v3.openView(store, 'c')
    expect(view).toMatchObject({ version: 2, head: 2, layout: 0, through: 0 })
    expect(dec.decode((await v3.getRecord(store, view, 't', 'a'))!.line!)).toContain('"data":2')
    const old = v3.viewAt(view, 1)!
    expect(dec.decode((await v3.getRecord(store, old, 't', 'a'))!.line!)).toContain('"data":1')
    await expect(v3.openView(store, 'c', { version: 3 })).rejects.toThrow(v3.VersionError)
    const empty = await v3.openView(store, 'nothing')
    expect(empty).toMatchObject({ version: 0, head: 0, files: [] })
    expect(await v3.getRecord(store, empty, 't', 'a')).toBe(null)
    expect(await v3.page(store, empty, { limit: 10 })).toEqual([])
  })

  it('opens only the files a read needs, and keeps their footers in the cache', async () => {
    const store = memoryStore()
    const pad = (i: number) => String(i).padStart(5, '0')
    const rows = Array.from({ length: 4000 }, (_, i) => line(rec('t', pad(i), 'x'.repeat(300))))
    await commitRows(store, 'c', rows, { maxBytes: 200_000 })
    const view = await v3.openView(store, 'c')
    expect(view.files.length).toBeGreaterThan(5)
    const cache = new v3.FileCache()
    store.gets = 0
    await v3.getRecord(store, view, 't', pad(1234), { cache })
    // One file covers the key: at most its tail (the footer), a key block, a record block.
    const cold = store.gets
    expect(cold).toBeGreaterThanOrEqual(1)
    expect(cold).toBeLessThanOrEqual(3)
    store.gets = 0
    await v3.getRecord(store, view, 't', pad(1235), { cache })
    // The footer is cached now.
    expect(store.gets).toBeLessThan(cold)
    store.gets = 0
    const got = await v3.page(
      store,
      view,
      { from: { type: 't', id: pad(2000) }, limit: 20 },
      { cache },
    )
    expect(got.length).toBe(20)
    // A page touches the one or two files its keys fall in, not all of them.
    expect(store.gets).toBeLessThanOrEqual(6)
  })
})
