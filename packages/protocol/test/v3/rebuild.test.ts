/** Rebuilds: every version reads the same before and after, and originals can be made again. */
import { describe, expect, it } from 'vitest'

import { listAll, memoryStore, type MemoryStore, v3 } from '../../src/index.js'
import { dec, rec, rem, rng } from './helpers.js'
import { checkReads, commitRows, Model, randomUpload } from './model.js'

const line = (r: v3.WriteRow): v3.LineRow => {
  if (r.kind === 'w') throw new Error('no line')
  return { kind: r.kind, type: r.type, id: r.id, line: r.line as string }
}

/** Delete every sorted-record-file the collection no longer lists (a one-collection sweep). */
async function dropUnlisted(store: MemoryStore, collection: string): Promise<number> {
  const { files } = await v3.currentFiles(store, collection)
  const listed = new Set(files.map((f) => v3.recordKey(f.id)))
  let dropped = 0
  for await (const key of listAll(store, 'records/')) {
    if (!listed.has(key)) {
      await store.delete(key)
      dropped++
    }
  }
  return dropped
}

async function verifyListed(store: MemoryStore, collection: string) {
  const { files } = await v3.currentFiles(store, collection)
  for (const f of files) {
    const v = await v3.verifyFile(store, v3.recordKey(f.id), { id: f.id, labeled: f.labeled })
    expect(v.content.entries).toBe(f.entries)
    if (f.labeled) expect(v.content.commits).toEqual(f.commits)
  }
  return files
}

describe('rebuilding against the model', () => {
  it('reads every version the same after any rebuild, with the originals gone', async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const rand = rng(seed * 7)
      const store = memoryStore()
      const model = new Model()
      const rounds = 3 + Math.floor(rand() * 3)
      for (let round = 0; round < rounds; round++) {
        const n = 1 + Math.floor(rand() * 5)
        for (let c = 0; c < n; c++) {
          const rows = randomUpload(rand)
          model.add(rows)
          await commitRows(store, 'c', rows, rand() < 0.3 ? { maxBytes: 300 } : {})
        }
        const roll = rand()
        const plan =
          roll < 0.35
            ? v3.planAll
            : roll < 0.7
              ? (groups: v3.FileGroup[]) => {
                  // Some neighbouring groups, anywhere in the log.
                  const from = Math.floor(rand() * groups.length)
                  const to = from + 1 + Math.floor(rand() * (groups.length - from))
                  return [groups.slice(from, to)]
                }
              : undefined
        const r = await v3.rebuild(store, 'c', {
          ...(plan ? { plan } : {}),
          tiers: { ratio: 2, baseBytes: 2000 },
          adoptAfter: 1,
          ...(rand() < 0.5 ? { maxBytes: 500, typeCutBytes: 200 } : {}),
          // Sometimes cut by key and keep files nothing changed in.
          ...(rand() < 0.5 ? { cutBytes: 400, keepUntouched: true } : {}),
        })
        expect(r.lost).toBe(false)
        expect(r.layout!.through).toBe(model.head)
        await dropUnlisted(store, 'c')
        await verifyListed(store, 'c')
        await checkReads(store, 'c', model, rand)
      }
      // Every commit's original files can be made again, with the ids the commits recorded.
      const { files } = await v3.currentFiles(store, 'c')
      for await (const c of v3.readLog(store, 'c', 1, model.head)) {
        const made = await v3.recreate(store, files, c.commit)
        expect(made.length).toBe(v3.commitFiles(c.commit).length)
        expect(
          made.every((m) => m.matches),
          `seed ${seed} commit ${c.commit.number}`,
        ).toBe(true)
      }
    }
  }, 300_000)
})

async function small() {
  const store = memoryStore()
  const model = new Model()
  const put = async (rows: v3.WriteRow[], opts: v3.BuildOptions = {}) => {
    const sorted = rows.map(line).sort(v3.compareKey)
    model.add(sorted)
    return commitRows(store, 'c', sorted, opts)
  }
  await put([
    rec('t', 'a', { v: 1 }),
    rec('t', 'b', { v: 1 }),
    rec('t', 'c', { v: 1 }),
    rec('u', 'x', 1),
  ])
  await put([rec('t', 'a', { v: 2 }), rem('t', 'b'), rec('t', 'd', { v: 1 })])
  await put([rec('t', 'a', { v: 2 }), rem('t', 'never'), rec('t', 'b', { v: 3 })])
  await put([rec('t', 'c', { secret: 'TOP-SECRET-LINE' }), rem('t', 'd')])
  await put([rec('t', 'c', { v: 5 }), rec('t', 'e', { v: 1 })])
  return { store, model, put }
}

describe('rebuild', () => {
  it('labels rows, keeps replaced rows beside the newest, and shares an unchanged line', async () => {
    const { store, model } = await small()
    const r = await v3.rebuild(store, 'c', { plan: v3.planAll })
    expect(r).toMatchObject({ merges: 1, filesIn: 5, filesOut: 1, dropped: 0, lost: false })
    const [f] = r.layout!.files
    expect(f).toMatchObject({ labeled: true, commits: [1, 5], group: 1 })
    expect(r.layout).toMatchObject({ number: 1, through: 5 })
    const reader = (await v3.SortedFile.open(store, v3.recordKey(f!.id))).reader()
    const a = await reader.lookup('t', 'a')
    expect(a.map((e) => [e.commit, e.kind])).toEqual([
      [1, 'r'],
      [2, 'r'],
      [3, 'r'],
    ])
    // Commit 3 rewrote `a` unchanged: one line, two entries.
    expect([a[1]!.block, a[1]!.offset]).toEqual([a[2]!.block, a[2]!.offset])
    // A removal of a key that never existed stays while its commit is retained.
    expect((await reader.lookup('t', 'never')).map((e) => [e.commit, e.kind])).toEqual([[3, 'x']])
    expect((await reader.lookup('t', 'b')).map((e) => e.kind)).toEqual(['r', 'x', 'r'])
    await checkReads(store, 'c', model, rng(1))
    expect(await dropUnlisted(store, 'c')).toBe(5)
    await checkReads(store, 'c', model, rng(2))
  })

  it('gives the same files for the same rows, and does not write a file twice', async () => {
    const a = await small()
    const b = await small()
    const ra = await v3.rebuild(a.store, 'c', { plan: v3.planAll, level: 1 })
    const rb = await v3.rebuild(b.store, 'c', { plan: v3.planAll, level: 9 })
    expect(ra.layout!.files.map((f) => f.id)).toEqual(rb.layout!.files.map((f) => f.id))
    expect(ra.written).toBeGreaterThan(0)
    // The same merge again finds its output stored.
    const again = await v3.rebuild(a.store, 'c', { plan: v3.planAll })
    expect(again.layout!.number).toBe(2)
    expect(again.written).toBe(0)
    expect(again.skipped).toBeGreaterThan(0)
  })

  it('leaves commits made since the last layout readable, then folds them in', async () => {
    const { store, model, put } = await small()
    await v3.rebuild(store, 'c', { plan: v3.planAll })
    await put([rec('t', 'a', { v: 9 }), rem('t', 'e')])
    await put([rec('t', 'f', { v: 1 })])
    const view = await v3.openView(store, 'c')
    expect(view).toMatchObject({ layout: 1, through: 5, version: 7 })
    expect(view.files.length).toBe(3)
    await checkReads(store, 'c', model, rng(3))
    // Nothing to merge by tier, and too few commits to adopt: no new layout.
    expect((await v3.rebuild(store, 'c')).layout).toBe(null)
    const adopted = await v3.rebuild(store, 'c', { adoptAfter: 2 })
    expect(adopted.layout).toMatchObject({ number: 2, through: 7 })
    expect(adopted.merges).toBe(0)
    expect(adopted.layout!.files.map((f) => [f.labeled, f.commits, f.group])).toEqual([
      [true, [1, 5], 1],
      [false, [6, 6], 0],
      [false, [7, 7], 0],
    ])
    await checkReads(store, 'c', model, rng(4))
  })

  it('lets one of two racing rebuilds create the layout', async () => {
    const { store, model } = await small()
    const [a, b] = await Promise.all([
      v3.rebuild(store, 'c', { plan: v3.planAll }),
      v3.rebuild(store, 'c', { plan: v3.planAll, maxBytes: 100 }),
    ])
    expect([a.lost, b.lost].sort()).toEqual([false, true])
    expect((await v3.findLayout(store, 'c'))!.number).toBe(1)
    await checkReads(store, 'c', model, rng(5))
  })

  it('takes fewer requests to read once rebuilt', async () => {
    const store = memoryStore()
    const pad = (i: number) => String(i).padStart(5, '0')
    const rand = rng(11)
    const text = () =>
      Array.from({ length: 40 }, () => Math.floor(rand() * 1e9).toString(36)).join('')
    await commitRows(
      store,
      'c',
      Array.from({ length: 3000 }, (_, i) => line(rec('t', pad(i), text()))),
    )
    for (let c = 0; c < 12; c++) {
      const ids = new Set<number>()
      while (ids.size < 400) ids.add(Math.floor(rand() * 3000))
      await commitRows(
        store,
        'c',
        [...ids].sort((a, b) => a - b).map((i) => line(rec('t', pad(i), text()))),
      )
    }
    const cost = async () => {
      const view = await v3.openView(store, 'c')
      store.gets = 0
      await v3.getRecord(store, view, 't', pad(1500))
      return { files: view.files.length, cold: store.gets }
    }
    const before = await cost()
    expect(before.files).toBe(13)
    await v3.rebuild(store, 'c', { plan: (groups) => [groups.slice(1)] })
    const after = await cost()
    expect(after.files).toBe(2)
    expect(after.cold).toBeLessThan(before.cold)
    // The first load and one merged group: a footer and a key block from each, and the record block.
    expect(after.cold).toBeLessThanOrEqual(5)
  })
})

describe('the tiered policy', () => {
  const g = (n: number, bytes: number): v3.FileGroup => ({
    group: 0,
    files: [],
    commits: [n, n],
    bytes,
  })
  const MB = 1024 * 1024

  it('merges ten neighbouring groups of one tier, the newest ten first', () => {
    const nine = Array.from({ length: 9 }, (_, i) => g(i + 1, 5 * MB))
    expect(v3.planTiered(nine)).toBe(null)
    const ten = [...nine, g(10, 6 * MB)]
    expect(v3.planTiered(ten)!.length).toBe(10)
    // A large first load is left alone; the ten dailies after it merge.
    const loaded = [g(1, 100_000 * MB), ...ten.map((r, i) => g(i + 2, r.bytes))]
    expect(v3.planTiered(loaded)!.map((r) => r.commits[0])).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ])
    // A group of another tier in between breaks them up.
    const broken = [
      ...nine.slice(0, 5),
      g(6, 500 * MB),
      ...nine.slice(5).map((r, i) => g(7 + i, r.bytes)),
    ]
    expect(v3.planTiered(broken)).toBe(null)
    expect(v3.planTiered(broken, { ratio: 4 })!.map((r) => r.commits[0])).toEqual([7, 8, 9, 10])
  })

  it('merges neighbours of uneven size, and does not rewrite a large group to take in small ones', () => {
    // Sizes that fall either side of a tier's edge: no ten are of one tier, but ten are at or below one.
    const uneven = Array.from({ length: 10 }, (_, i) => g(i + 1, (i % 2 ? 5 : 20) * MB))
    expect(v3.planTiered(uneven)!.length).toBe(10)
    expect(v3.planTiered(uneven.slice(1))).toBe(null)
    // One 600 MB group and nine small ones: merging would rewrite 600 MB to add 45.
    const lopsided = [g(1, 600 * MB), ...Array.from({ length: 9 }, (_, i) => g(i + 2, 5 * MB))]
    expect(v3.planTiered(lopsided)).toBe(null)
    // A tenth small one: the small ones merge with each other, and the large one is left.
    const more = [...lopsided, g(11, 5 * MB)]
    expect(v3.planTiered(more)!.map((r) => r.commits[0])).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    // Small groups behind enough large ones go in with them.
    const mixed = [
      ...Array.from({ length: 3 }, (_, i) => g(i + 1, 5 * MB)),
      ...Array.from({ length: 8 }, (_, i) => g(i + 4, 300 * MB)),
    ]
    expect(v3.planTiered(mixed)!.length).toBe(11)
  })

  it('puts groups a factor of the ratio apart in different tiers', () => {
    expect(v3.tierOf(1, 10, 8 * MB)).toBe(0)
    expect(v3.tierOf(8 * MB, 10, 8 * MB)).toBe(0)
    expect(v3.tierOf(8 * MB + 1, 10, 8 * MB)).toBe(1)
    expect(v3.tierOf(80 * MB, 10, 8 * MB)).toBe(1)
    expect(v3.tierOf(600 * MB, 10, 8 * MB)).toBe(2)
    expect(v3.tierOf(6000 * MB, 10, 8 * MB)).toBe(3)
  })

  it('cascades: merged groups merge again when there are enough of them', async () => {
    const store = memoryStore()
    const model = new Model()
    const rand = rng(21)
    let merges = 0
    for (let c = 0; c < 27; c++) {
      // Uploads of one size, so tiers are a matter of how many have been merged.
      const rows = Array.from({ length: 20 }, (_, i) =>
        line(
          rec('t', `c${String(c).padStart(2, '0')}-${String(i).padStart(2, '0')}`, 'd'.repeat(80)),
        ),
      )
      if (c > 0) rows.push(line(rec('t', 'shared', { c })))
      rows.sort(v3.compareKey)
      model.add(rows)
      await commitRows(store, 'c', rows)
      for (;;) {
        const r = await v3.rebuild(store, 'c', {
          tiers: { ratio: 3, baseBytes: 500 },
          adoptAfter: 99,
        })
        if (!r.layout) break
        merges += r.merges
      }
    }
    const { files } = await v3.currentFiles(store, 'c')
    const groups = v3.groupsOf(files)
    // 27 uploads at a ratio of 3: groups merge and merge again, and never pile up.
    expect(groups.length).toBeLessThanOrEqual(6)
    expect(merges).toBeGreaterThanOrEqual(8)
    expect(groups[0]!.commits[0]).toBe(1)
    expect(groups[groups.length - 1]!.commits[1]).toBe(27)
    // Groups stay in commit order, their commit ranges not overlapping.
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i]!.commits[0]).toBeGreaterThan(groups[i - 1]!.commits[1])
    }
    await checkReads(store, 'c', model, rand, {
      versions: [1, 9, 20, 27],
      keys: [
        { type: 't', id: 'shared' },
        { type: 't', id: 'c05-07' },
      ],
    })
  }, 60_000)
})

describe('thinning', () => {
  it('drops rows no retained version sees, and refuses the versions it dropped', async () => {
    const { store, model } = await small()
    const full = await v3.rebuild(store, 'c', { plan: v3.planAll })
    const r = await v3.rebuild(store, 'c', { plan: v3.planAll, retained: [[4, 5]] })
    expect(r.layout!.retained).toEqual([[4, 5]])
    expect(r.dropped).toBeGreaterThan(0)
    expect(r.layout!.files[0]!.entries).toBeLessThan(full.layout!.files[0]!.entries)
    await dropUnlisted(store, 'c')
    await checkReads(store, 'c', model, rng(6), { versions: [4, 5], thinned: true })
    for (const version of [1, 2, 3]) {
      await expect(v3.openView(store, 'c', { version })).rejects.toThrow(/no longer holds/)
    }
    // `b` was removed at 2 and put back at 3: versions 4 and 5 see only the last row.
    const reader = (await v3.SortedFile.open(store, v3.recordKey(r.layout!.files[0]!.id))).reader()
    expect((await reader.lookup('t', 'b')).map((e) => e.commit)).toEqual([3])
    // `d` was removed at 4, a retained version: its row at 2 goes, the removal stays.
    expect((await reader.lookup('t', 'd')).map((e) => [e.commit, e.kind])).toEqual([[4, 'x']])
    // The removal of a key that never existed, at 3, goes: no retained version wrote it.
    expect(await reader.lookup('t', 'never')).toEqual([])
    // Commit 1's file can no longer be made again in full; commit 5's can.
    const { files } = await v3.currentFiles(store, 'c')
    const c1 = (await v3.readCommit(store, 'c', 1))!.commit
    const c5 = (await v3.readCommit(store, 'c', 5))!.commit
    expect((await v3.recreate(store, files, c1)).every((m) => m.matches)).toBe(false)
    expect((await v3.recreate(store, files, c5)).every((m) => m.matches)).toBe(true)
  })

  it('keeps later versions readable as commits land after a thinning', async () => {
    const { store, model, put } = await small()
    await v3.rebuild(store, 'c', {
      plan: v3.planAll,
      retained: [
        [3, 3],
        [5, 5],
      ],
    })
    await put([rec('t', 'a', { v: 10 })])
    await put([rem('t', 'a')])
    const r = await v3.rebuild(store, 'c', { plan: v3.planAll })
    expect(r.layout!.retained).toEqual([
      [3, 3],
      [5, 7],
    ])
    await dropUnlisted(store, 'c')
    await checkReads(store, 'c', model, rng(7), { versions: [3, 5, 6, 7], thinned: true })
    await expect(v3.openView(store, 'c', { version: 4 })).rejects.toThrow(/no longer holds/)
  })
})

describe('takedown', () => {
  it("removes a record's bytes from every file and keeps its history", async () => {
    const { store, model } = await small()
    await v3.rebuild(store, 'c', { plan: (groups) => [groups.slice(0, 3)] })
    const secretHash = model.commits[3]!.get('["t","c"]')!.hash!
    const { files } = await v3.currentFiles(store, 'c')
    const plan = await v3.planGroupsHolding(store, v3.groupsOf(files), [{ type: 't', id: 'c' }])
    // The key has rows in the merged group (commit 1) and in commits 4 and 5.
    expect(plan.length).toBe(3)
    const before = await v3.findLayout(store, 'c')
    const r = await v3.rebuild(store, 'c', {
      plan: () => plan,
      takedown: (type, id, hash) => type === 't' && id === 'c' && hash === secretHash,
    })
    expect(r.merges).toBe(3)
    // Groups keep their numbers: the layout is not regrouped.
    expect(before!.files.map((f) => f.group)).toEqual([1, 0, 0])
    expect(r.layout!.files.map((f) => [f.group, f.labeled, f.commits])).toEqual([
      [1, true, [1, 3]],
      [0, true, [4, 4]],
      [0, true, [5, 5]],
    ])
    await dropUnlisted(store, 'c')
    const withheld = (row: { hash: string | null }) => row.hash === secretHash
    await checkReads(store, 'c', model, rng(8), { withheld })
    const view = await v3.openView(store, 'c', { version: 4 })
    const got = await v3.getRecord(store, view, 't', 'c')
    expect(got).toMatchObject({ hash: secretHash, commit: 4, line: null })
    // The bytes are in no stored file.
    for await (const key of listAll(store, 'records/')) {
      const file = await v3.SortedFile.open(store, key)
      const reader = file.reader()
      for (let i = 0; i < file.locator.recordBlocks.length; i++) {
        expect(dec.decode(await reader.recordBlock(i))).not.toContain('TOP-SECRET-LINE')
      }
    }
    await verifyListed(store, 'c')
    // Commit ids are unchanged, and the commit holding the row can no longer be recreated.
    await v3.verifyLog(store, 'c')
    const c4 = (await v3.readCommit(store, 'c', 4))!.commit
    const now = (await v3.currentFiles(store, 'c')).files
    expect((await v3.recreate(store, now, c4)).every((m) => m.matches)).toBe(false)
  })
})

describe('recreating originals', () => {
  it("writes a commit's files again, byte for byte the same rows, with the same ids", async () => {
    const store = memoryStore()
    const model = new Model()
    const pad = (i: number) => String(i).padStart(4, '0')
    const rows = Array.from({ length: 900 }, (_, i) => line(rec('t', pad(i), 'r'.repeat(100))))
    model.add(rows)
    const first = await commitRows(store, 'c', rows, { maxBytes: 20_000 })
    expect(v3.commitFiles(first.commit).length).toBeGreaterThan(3)
    const second = [line(rec('t', pad(5), 2)), line(rem('t', pad(6))), line(rec('u', 'x', 1))]
    model.add(second)
    await commitRows(store, 'c', second)
    await commitRows(store, 'c', [])
    model.add([])
    await v3.rebuild(store, 'c', { plan: v3.planAll, maxBytes: 50_000 })
    expect(await dropUnlisted(store, 'c')).toBeGreaterThan(4)
    const { files } = await v3.currentFiles(store, 'c')
    for await (const c of v3.readLog(store, 'c', 1, 3)) {
      const want = v3.commitFiles(c.commit)
      for (const f of want) expect(await store.head(v3.recordKey(f.id))).toBe(null)
      const made = await v3.recreate(store, files, c.commit, { target: v3.storeTarget(store) })
      expect(made.map((m) => m.id).sort()).toEqual(want.map((f) => f.id).sort())
      for (const f of want) {
        await v3.verifyFile(store, v3.recordKey(f.id), {
          id: f.id,
          canonical: true,
          labeled: false,
        })
      }
    }
    await v3.verifyLog(store, 'c', { files: true })
  })
})

describe('cutting by key and keeping untouched files', () => {
  const pad = (i: number) => String(i).padStart(5, '0')
  const base = (n: number) =>
    Array.from({ length: n }, (_, i) => line(rec('t', pad(i), { i, text: 'x'.repeat(60) })))

  it('picks cut keys from the key and its row alone, so files come out near the target', () => {
    let cuts = 0
    for (let i = 0; i < 20_000; i++) if (v3.keyCut('t', pad(i), 99, 5000)) cuts++
    // 20,000 rows of 100 bytes with their newlines, toward 5,000 bytes a file: about 400 cuts.
    expect(cuts).toBeGreaterThan(330)
    expect(cuts).toBeLessThan(470)
    expect(v3.keyCut('t', pad(7), 99, 5000)).toBe(v3.keyCut('t', pad(7), 99, 5000))
    // A larger row is more likely to end a file; one as large as the target always does.
    let big = 0
    for (let i = 0; i < 20_000; i++) if (v3.keyCut('t', pad(i), 999, 5000)) big++
    expect(big).toBeGreaterThan(cuts * 8)
    expect(v3.keyCut('t', 'a', 5000, 5000)).toBe(true)
  })

  it('gives the same files for the same stretch of keys, whatever else is in the build', async () => {
    const store = memoryStore()
    const rows = base(3000)
    const a = await v3.buildFiles(rows, v3.storeTarget(store), { cutBytes: 10_000 })
    expect(a.length).toBeGreaterThan(15)
    // One record changed, and one added far from it.
    const changed = rows.map((r) => (r.id === pad(1500) ? line(rec('t', pad(1500), 'new')) : r))
    changed.push(line(rec('t', pad(2990) + 'x', 'added')))
    changed.sort(v3.compareKey)
    const b = await v3.buildFiles(changed, v3.storeTarget(store), { cutBytes: 10_000 })
    const ids = new Set(a.map((f) => f.id))
    const fresh = b.filter((f) => !ids.has(f.id))
    // Only the files holding the changed and the added key differ (an added cut key could split one).
    expect(fresh.length).toBeGreaterThanOrEqual(2)
    expect(fresh.length).toBeLessThanOrEqual(3)
    expect(b.length).toBeGreaterThanOrEqual(a.length)
  })

  it('rewrites only the files a change falls in, and reads the same', async () => {
    const store = memoryStore()
    const model = new Model()
    const rows = base(3000)
    model.add(rows)
    await commitRows(store, 'c', rows, { cutBytes: 10_000 })
    const edit = [line(rec('t', pad(1500), 'edited')), line(rem('t', pad(1501)))]
    model.add(edit)
    await commitRows(store, 'c', edit)
    const before = (await v3.currentFiles(store, 'c')).files
    const r = await v3.rebuild(store, 'c', {
      plan: v3.planAll,
      cutBytes: 10_000,
      keepUntouched: true,
    })
    // Both edits sit in one of the load's files: that one is merged, the rest are kept.
    expect(r.kept).toBe(before.length - 2)
    expect(r.filesOut).toBe(1)
    expect(r.filesIn).toBe(before.length)
    const kept = new Set(before.map((f) => f.id))
    const layout = r.layout!
    expect(layout.files.filter((f) => kept.has(f.id)).length).toBe(before.length - 2)
    // One group now, its files in key order with ranges that do not overlap.
    expect(v3.groupsOf(layout.files).length).toBe(1)
    const sorted = [...layout.files].sort((x, y) =>
      v3.compareKeys(x.first![0], x.first![1], y.first![0], y.first![1]),
    )
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1]!.last!
      const f = sorted[i]!.first!
      expect(v3.compareKeys(p[0], p[1], f[0], f[1])).toBeLessThan(0)
    }
    await dropUnlisted(store, 'c')
    await verifyListed(store, 'c')
    await checkReads(store, 'c', model, rng(31), {
      keys: [1499, 1500, 1501, 1502, 0, 2999].map((i) => ({ type: 't', id: pad(i) })),
    })
    // The originals still recreate from what is listed.
    const files = (await v3.currentFiles(store, 'c')).files
    for await (const c of v3.readLog(store, 'c', 1, 2)) {
      expect((await v3.recreate(store, files, c.commit)).every((m) => m.matches)).toBe(true)
    }
    // A second rebuild with nothing new keeps every file and writes nothing.
    const again = await v3.rebuild(store, 'c', {
      plan: v3.planAll,
      cutBytes: 10_000,
      keepUntouched: true,
    })
    expect(again).toMatchObject({ filesOut: 0, written: 0, kept: layout.files.length })
  })

  it('costs a fork that edits one record one file, not the collection', async () => {
    const store = memoryStore()
    const rows = base(3000)
    await commitRows(store, 'parent', rows, { cutBytes: 10_000 })
    await v3.forkCollection(store, 'parent', 'fork')
    await commitRows(store, 'fork', [line(rec('t', pad(42), 'forked'))])
    const r = await v3.rebuild(store, 'fork', {
      plan: v3.planAll,
      cutBytes: 10_000,
      keepUntouched: true,
    })
    expect(r.filesOut).toBe(1)
    const parent = new Set((await v3.currentFiles(store, 'parent')).files.map((f) => f.id))
    const fork = (await v3.currentFiles(store, 'fork')).files
    // Every file but the rewritten one is still the parent's own.
    expect(fork.filter((f) => !parent.has(f.id)).length).toBe(1)
    expect(fork.length).toBe(parent.size)
    const s = await v3.sweep(store, { now: () => 0 })
    const p = s.logical.get('parent')!.bytes
    const f = s.logical.get('fork')!.bytes
    // Stored once: the parent, and one file of the fork's.
    expect(s.records.listedBytes - p).toBeLessThan(p / 15)
    expect(f).toBeGreaterThan(p * 0.95)
  })
})
