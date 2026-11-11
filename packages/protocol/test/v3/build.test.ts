/** Building an upload: parsing, the external sort, and cutting files. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { listAll, memoryStore, v3 } from '../../src/index.js'
import { rec, rem, rng } from './helpers.js'

const enc = new TextEncoder()

/** Upload lines in no order, some keys given more than once; and what they should sort to. */
function upload(n: number, seed: number) {
  const rand = rng(seed)
  const lines: string[] = []
  const last = new Map<string, v3.LineRow>()
  for (let i = 0; i < n; i++) {
    const type = ['work', 'author', 'é'][Math.floor(rand() * 3)]!
    const id = `k${Math.floor(rand() * n * 0.7)}`
    const removed = rand() < 0.1
    const line = removed
      ? JSON.stringify({ id, type, removed: true })
      : JSON.stringify({ type, id, data: { b: i, a: 'x'.repeat(Math.floor(rand() * 200)) } })
    lines.push(line)
    last.set(JSON.stringify([type, id]), v3.parseInputLine(line))
  }
  const want = [...last.values()]
    .sort(v3.compareKey)
    .map((r) => ({ kind: r.kind, type: r.type, id: r.id, line: r.line }))
  return { bytes: enc.encode(lines.join('\n') + '\n'), want }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

/** The bytes in pieces of odd sizes, so lines straddle chunk edges. */
function* pieces(bytes: Uint8Array, size = 777): Generator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

describe('sorting an upload', () => {
  it('sorts in memory when it fits, keeping the last line given for a key', async () => {
    const { bytes, want } = upload(3000, 1)
    const scratch = memoryStore()
    const got = await collect(v3.sortRows(v3.parseUpload(pieces(bytes)), scratch))
    expect(got).toEqual(want)
    expect(scratch.puts).toBe(0)
  })

  it('spills and merges, in one pass and in several, to the same result', async () => {
    const { bytes, want } = upload(4000, 2)
    for (const [memoryBytes, fanIn] of [
      [200_000, 48],
      [60_000, 3],
      [20_000, 2],
    ] as const) {
      const scratch = memoryStore()
      const got = await collect(
        v3.sortRows(v3.parseUpload(pieces(bytes)), scratch, { memoryBytes, fanIn }),
      )
      expect(got).toEqual(want)
      expect(scratch.puts).toBeGreaterThan(3)
      // Every spilled chunk is gone.
      expect(await collect(listAll(scratch, ''))).toEqual([])
    }
  })

  it('cleans up its chunks when the reader stops early or the input is bad', async () => {
    const { bytes } = upload(2000, 3)
    const scratch = memoryStore()
    for await (const _ of v3.sortRows(v3.parseUpload(pieces(bytes)), scratch, {
      memoryBytes: 30_000,
    })) {
      break
    }
    expect(await collect(listAll(scratch, ''))).toEqual([])
    const bad = enc.encode('{"id":"a","type":"t","data":1}\n{"id":"b","type":"t"}\n')
    await expect(collect(v3.sortRows(v3.parseUpload([bad]), scratch))).rejects.toThrow(/record is/i)
  })
})

describe('building files', () => {
  it('builds sorted input in one pass and refuses input out of order', async () => {
    const store = memoryStore()
    const rows = Array.from({ length: 500 }, (_, i) => rec('t', String(i).padStart(4, '0'), { i }))
    const [f] = await v3.buildFiles(rows, v3.storeTarget(store))
    expect(f).toMatchObject({ entries: 500, records: 500, labeled: false, commits: null })
    expect(f!.first).toEqual(['t', '0000'])
    expect((await store.head(v3.recordKey(f!.id)))!.size).toBe(f!.size)
    await v3.verifyFile(store, v3.recordKey(f!.id), { id: f!.id, canonical: true })
    await expect(
      v3.buildFiles([rec('t', 'b', 1), rec('t', 'a', 1)], v3.storeTarget(store)),
    ).rejects.toThrow(/order/)
    expect((await collect(listAll(store, ''))).length).toBe(1)
  })

  it('cuts a large upload into files by key range', async () => {
    const store = memoryStore()
    const { bytes } = upload(4000, 4)
    const files = await v3.buildFiles(
      v3.sortRows(v3.parseUpload([bytes]), store),
      v3.storeTarget(store),
      { maxBytes: 40_000 },
    )
    expect(files.length).toBeGreaterThan(5)
    let entries = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!
      entries += f.entries
      await v3.verifyFile(store, v3.recordKey(f.id), { id: f.id, canonical: true })
      if (i > 0) {
        const before = files[i - 1]!.last!
        expect(v3.compareKeys(before[0], before[1], f.first![0], f.first![1])).toBeLessThan(0)
      }
      if (i < files.length - 1) expect(f.bytes).toBeGreaterThanOrEqual(40_000)
    }
    const one = await v3.buildFiles(
      v3.sortRows(v3.parseUpload([bytes]), store),
      v3.storeTarget(store),
    )
    expect(one.length).toBe(1)
    expect(entries).toBe(one[0]!.entries)

    const byEntries = await v3.buildFiles(
      v3.sortRows(v3.parseUpload([bytes]), store),
      v3.storeTarget(store),
      { maxEntries: 1000 },
    )
    expect(byEntries.map((f) => f.entries).slice(0, -1)).toEqual(
      byEntries.slice(0, -1).map(() => 1000),
    )
  })

  it('gives the same files for the same rows, however the work was split', async () => {
    const store = memoryStore()
    const rows: v3.LineRow[] = []
    for await (const r of v3.sortRows(v3.parseUpload([upload(6000, 9).bytes]), store)) rows.push(r)
    const N = rows.length
    // Small targets so a few thousand rows make dozens of files, with the cap in play too.
    const opts = { cutBytes: 20_000, maxBytes: 60_000, typeCutBytes: 10_000 }
    const ids = async (parts: (v3.WriteRow[] | AsyncIterable<v3.WriteRow>)[], o: v3.BuildOptions) =>
      (await Promise.all(parts.map((p) => v3.buildFiles(p, v3.storeTarget(memoryStore()), o))))
        .flat()
        .map((f) => f.id)
    const one = await ids([rows], opts)
    expect(one.length).toBeGreaterThan(20)
    // Another gzip level, the same files.
    expect(await ids([rows], { ...opts, level: 1 })).toEqual(one)
    // Parts that end wherever they end: the files at each seam differ.
    const split = (n: number) =>
      Array.from({ length: n }, (_, k) =>
        rows.slice(Math.floor((k * N) / n), Math.floor(((k + 1) * N) / n)),
      )
    expect(await ids(split(7), opts)).not.toEqual(one)
    // Parts moved to end on cut keys: the same files, for any number of parts.
    for (const n of [2, 7, 40]) {
      const parts = Array.from({ length: n }, (_, k) => {
        const start = Math.floor((k * N) / n)
        const end = Math.floor(((k + 1) * N) / n)
        let i = start
        const from = {
          *[Symbol.iterator]() {
            for (; i < N; i++) yield rows[i]!
          },
        }
        return v3.partOnCuts(from, {
          first: k === 0,
          past: () => i >= end,
          cutBytes: opts.cutBytes,
        })
      })
      expect(await ids(parts, opts)).toEqual(one)
    }
    // A row added changes the file it falls in and no other.
    const extra = rec('work', 'k0-added', { a: 'new' })
    const more = [...rows, extra].sort(v3.compareKey)
    const after = await ids([more], opts)
    expect(after.filter((id) => !one.includes(id)).length).toBeLessThanOrEqual(2)
    expect(one.filter((id) => !after.includes(id)).length).toBeLessThanOrEqual(2)
  })

  it('cuts where the type changes once a file is large enough, and keeps a key together', async () => {
    const store = memoryStore()
    const rows = [
      rec('$schema', 'a', {}),
      ...Array.from({ length: 50 }, (_, i) =>
        rec('a', String(i).padStart(3, '0'), 'x'.repeat(100)),
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        rec('b', String(i).padStart(3, '0'), 'x'.repeat(100)),
      ),
      rem('c', '1'),
    ]
    const files = await v3.buildFiles(rows, v3.storeTarget(store), { typeCutBytes: 1000 })
    expect(files.map((f) => [f.first![0], f.last![0], f.entries])).toEqual([
      ['$schema', 'a', 51],
      ['b', 'b', 50],
      ['c', 'c', 1],
    ])
    const labeled = [1, 2, 3, 4, 5, 6]
      .flatMap((c) => [rec('t', 'a', c, c)])
      .concat([rec('t', 'b', 1, 1)])
    const cut = await v3.buildFiles(labeled, v3.storeTarget(store), {
      labeled: true,
      maxEntries: 2,
    })
    expect(cut.map((f) => f.entries)).toEqual([6, 1])
    expect(cut[0]!.commits).toEqual([1, 6])
  })

  it('writes a large file through a temporary key, and leaves a stored file alone', async () => {
    const store = memoryStore()
    const rows = Array.from({ length: 200 }, (_, i) =>
      rec('t', String(i).padStart(4, '0'), { text: `${i}`.repeat(300) }),
    )
    const [small] = await v3.buildFiles(rows, v3.storeTarget(store))
    const before = (await (await store.get(v3.recordKey(small!.id)))!.bytes()).slice()
    // The same rows at another gzip level have the same id: the stored bytes stay.
    const [big] = await v3.buildFiles(rows, v3.storeTarget(store, { memoryBytes: 1000 }), {
      level: 1,
    })
    expect(big!.id).toBe(small!.id)
    expect(big!.size).not.toBe(small!.size)
    expect(await (await store.get(v3.recordKey(small!.id)))!.bytes()).toEqual(before)
    expect(await collect(listAll(store, 'tmp/'))).toEqual([])

    const other = memoryStore()
    const [moved] = await v3.buildFiles(rows, v3.storeTarget(other, { memoryBytes: 1000 }))
    await v3.verifyFile(other, v3.recordKey(moved!.id), { id: small!.id })
    expect(await collect(listAll(other, 'tmp/'))).toEqual([])
  })
})

describe('memory', () => {
  // 2 GB with UL_V3_SORT_BYTES=2147483648 (the plan's size; about three minutes).
  const bytes = Number(process.env.UL_V3_SORT_BYTES ?? 192 * 1024 * 1024)
  it(`sorts ${Math.round(bytes / 1048576)} MB of unsorted input under a 120 MB heap`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ul-v3-sort-'))
    try {
      const script = join(dirname(fileURLToPath(import.meta.url)), 'sort-memory.ts')
      const { stdout } = await promisify(execFile)(
        process.execPath,
        // 96 MB of old space and three 8 MB semi-spaces: at most 120 MB of heap in all.
        // (--max-old-space-size=128 alone lets Node take 320 MB.)
        [
          '--max-old-space-size=96',
          '--max-semi-space-size=8',
          '--import',
          'tsx',
          script,
          String(bytes),
          dir,
        ],
        { maxBuffer: 1 << 20 },
      )
      const r = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, number | boolean>
      console.log('sort-memory', r)
      expect(r.ordered).toBe(true)
      expect(r.entries).toBe(r.records)
      expect(r.scratchLeft).toBe(0)
      // The heap cap is the test: over it, the child dies. Buffers (gzip, file reads) sit outside it.
      expect(r.peakRssMb as number).toBeLessThan(640)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 900_000)
})
