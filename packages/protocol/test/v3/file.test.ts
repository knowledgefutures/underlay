/** The sorted-record-file: writer, reader, verifier (docs/protocol-v3.md, Section 3). */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { gzip, InputRuleError, memoryStore, sha256Hex, v3 } from '../../src/index.js'
import vectors from '../vectors/v3-files.json' with { type: 'json' }
import { dec, putFile, rec, rem, rng, sortRows } from './helpers.js'

const pad = (n: number) => String(n).padStart(6, '0')

function manyRows(n: number, size = 300): v3.WriteRow[] {
  const rows: v3.WriteRow[] = []
  for (let i = 0; i < n; i++) {
    rows.push(
      i % 97 === 5
        ? rem('work', pad(i))
        : rec('work', pad(i), { n: i, text: 'x'.repeat(size + (i % 13)) }),
    )
  }
  return rows
}

describe('writing and reading', () => {
  it('round-trips rows through point lookups and a cursor', async () => {
    const store = memoryStore()
    const rows = sortRows([
      ...manyRows(5000),
      rec('$schema', 'work', { type: 'object' }),
      rec('author', 'a1', { name: 'A' }),
    ])
    const f = await putFile(store, rows)
    expect(f.content.entries).toBe(rows.length)
    expect(f.content.lines).toBe(rows.length)
    expect(f.content.keyBlocks.length).toBe(Math.ceil(rows.length / 1024))
    expect(f.content.first).toEqual(['$schema', 'work'])
    expect(f.content.last).toEqual(['work', pad(4999)])

    const file = await v3.SortedFile.open(store, f.key, { id: f.id })
    expect(file.size).toBe(f.size)
    const reader = file.reader()
    for (const i of [0, 1, 5, 1023, 1024, 1025, 2500, 4999]) {
      const [e] = await reader.lookup('work', pad(i))
      const row = rows.find((r) => r.type === 'work' && r.id === pad(i))!
      expect(e!.kind).toBe(row.kind)
      expect(dec.decode(await reader.line(e!))).toBe((row as { line: string }).line)
    }
    expect(await reader.lookup('work', 'nope')).toEqual([])
    expect(await reader.lookup('zzz', '1')).toEqual([])
    expect(await reader.lookup('$asset', '1')).toEqual([])

    const cursor = new v3.EntryCursor(file.reader({ readAhead: 1 << 20 }), 7)
    await cursor.seek()
    const seen: string[] = []
    while (cursor.current) {
      expect(cursor.current.commit).toBe(7)
      seen.push(cursor.current.type + '/' + cursor.current.id)
      await cursor.next()
    }
    expect(seen).toEqual(rows.map((r) => r.type + '/' + r.id))
    await cursor.seek({ type: 'work', id: pad(3000) + 'x' })
    expect(cursor.current!.id).toBe(pad(3001))
    await cursor.seek({ type: 'zzz', id: '' })
    expect(cursor.current).toBe(null)
  })

  it('reads a small file in one request, and a large one in one per block', async () => {
    const store = memoryStore()
    const small = await putFile(store, manyRows(50))
    store.gets = 0
    const sf = await v3.SortedFile.open(store, small.key, { id: small.id })
    const [e] = await sf.reader().lookup('work', pad(10))
    await sf.reader().line(e!)
    expect(store.gets).toBe(1)

    const big = await putFile(store, manyRows(20_000, 2000))
    store.gets = 0
    const bf = await v3.SortedFile.open(store, big.key, { id: big.id })
    expect(store.gets).toBe(1)
    const r = bf.reader()
    const [b] = await r.lookup('work', pad(7777))
    await r.line(b!)
    // The footer, one key block, one record block.
    expect(store.gets).toBe(3)
  })

  it('fetches a block once for lines read from it at the same time', async () => {
    const store = memoryStore()
    const rows = manyRows(20_000, 2000)
    const big = await putFile(store, rows)
    const bf = await v3.SortedFile.open(store, big.key, { id: big.id })
    const r = bf.reader()
    const entries = await Promise.all(
      Array.from({ length: 300 }, (_, i) => r.lookup('work', pad(7000 + i)).then(([e]) => e!)),
    )
    const blocks = new Set(entries.map((e) => e.block))
    expect(blocks.size).toBeGreaterThan(1)
    store.gets = 0
    const lines = await Promise.all(entries.map((e) => r.line(e)))
    expect(store.gets).toBe(blocks.size)
    for (const [i, line] of lines.entries()) {
      const row = rows.find((x) => x.id === pad(7000 + i)) as { line: string }
      expect(dec.decode(line)).toBe(row.line)
    }
  })

  it('cuts record blocks after the first line at or past 262,144 bytes', async () => {
    const store = memoryStore()
    const f = await putFile(store, manyRows(3000, 1000))
    const file = await v3.SortedFile.open(store, f.key)
    const r = file.reader()
    const n = file.locator.recordBlocks.length
    expect(n).toBeGreaterThan(5)
    for (let i = 0; i < n; i++) {
      const block = await r.recordBlock(i)
      if (i < n - 1) {
        expect(block.byteLength).toBeGreaterThanOrEqual(v3.RECORD_BLOCK_BYTES)
        // Without its last line the block is under the cut.
        const lastLine = block.subarray(0, block.byteLength - 1).lastIndexOf(0x0a) + 1
        expect(lastLine).toBeLessThan(v3.RECORD_BLOCK_BYTES)
      }
    }
  })

  it('holds a record of 8 MiB', async () => {
    const store = memoryStore()
    const big = 'y'.repeat(8 * 1024 * 1024 - 100)
    const rows = [rec('t', 'a', { s: 'small' }), rec('t', 'b', { big }), rec('t', 'c', 1)]
    const f = await putFile(store, rows)
    expect(f.content.bytes).toBeGreaterThan(8 * 1024 * 1024 - 100)
    const file = await v3.SortedFile.open(store, f.key, { id: f.id })
    const r = file.reader()
    const [e] = await r.lookup('t', 'b')
    expect((await r.line(e!)).byteLength).toBe(e!.size)
    const [c] = await r.lookup('t', 'c')
    expect(dec.decode(await r.line(c!))).toBe('{"id":"c","type":"t","data":1}')
    expect((await v3.verifyFile(store, f.key, { id: f.id, canonical: true })).id).toBe(f.id)
  })

  it('writes and reads an empty file', async () => {
    const store = memoryStore()
    const f = await putFile(store, [])
    expect(f.content).toMatchObject({ entries: 0, lines: 0, bytes: 0, first: null, last: null })
    expect(f.content.keyBlocks).toEqual([])
    const file = await v3.SortedFile.open(store, f.key, { id: f.id })
    expect(await file.reader().lookup('a', 'b')).toEqual([])
    const cursor = new v3.EntryCursor(file.reader(), 1)
    await cursor.seek()
    expect(cursor.current).toBe(null)
    await v3.verifyFile(store, f.key, { id: f.id })
  })

  it('refuses rows out of order and duplicate keys', async () => {
    await expect(v3.writeFileBytes([rec('t', 'b', 1), rec('t', 'a', 1)])).rejects.toThrow(/order/)
    await expect(v3.writeFileBytes([rec('t', 'a', 1), rec('t', 'a', 2)])).rejects.toThrow(/order/)
    await expect(v3.writeFileBytes([rec('u', 'a', 1), rec('t', 'b', 2)])).rejects.toThrow(/order/)
    await expect(
      v3.writeFileBytes([rec('t', 'a', 1, 2), rec('t', 'a', 1, 2)], { labeled: true }),
    ).rejects.toThrow(/order/)
  })

  it('labels rows, and stores a row rewritten unchanged once', async () => {
    const store = memoryStore()
    const rows = sortRows([
      rec('t', 'a', { v: 1 }, 1),
      rec('t', 'a', { v: 1 }, 4),
      rec('t', 'a', { v: 2 }, 6),
      rec('t', 'a', { v: 1 }, 9),
      rec('t', 'b', { v: 1 }, 2),
      rem('t', 'b', 3),
      rem('t', 'b', 5),
      { kind: 'w', type: 't', id: 'c', hash: sha256Hex('gone'), size: 4, commit: 2 } as const,
      rec('t', 'c', { v: 3 }, 8),
    ])
    const f = await putFile(store, rows, { labeled: true })
    expect(f.content).toMatchObject({
      labeled: true,
      entries: 9,
      lines: 6,
      records: 6,
      removals: 2,
      withheld: 1,
      commits: [1, 9],
    })
    const r = (await v3.SortedFile.open(store, f.key, { id: f.id })).reader()
    const a = await r.lookup('t', 'a')
    expect(a.map((e) => e.commit)).toEqual([1, 4, 6, 9])
    expect([a[0]!.block, a[0]!.offset]).toEqual([a[1]!.block, a[1]!.offset])
    expect(a[3]!.offset).not.toBe(a[0]!.offset)
    const b = await r.lookup('t', 'b')
    expect(b.map((e) => e.kind)).toEqual(['r', 'x', 'x'])
    expect(b[1]!.offset).toBe(b[2]!.offset)
    const c = await r.lookup('t', 'c')
    expect(c[0]).toMatchObject({ kind: 'w', block: null, offset: null })
    await expect(r.line(c[0]!)).rejects.toThrow(/withheld/)
    await v3.verifyFile(store, f.key, { id: f.id, canonical: true, labeled: true })
  })

  it("finds a key's entries across a key block boundary in a labeled file", async () => {
    const store = memoryStore()
    const rows: v3.WriteRow[] = []
    for (let i = 0; i < 1020; i++) rows.push(rec('t', pad(i), i, 1))
    for (let c = 1; c <= 10; c++) rows.push(rec('t', pad(2000), c, c))
    for (let i = 3000; i < 3100; i++) rows.push(rec('t', pad(i), i, 1))
    const f = await putFile(store, rows, { labeled: true })
    const r = (await v3.SortedFile.open(store, f.key)).reader()
    expect((await r.lookup('t', pad(2000))).map((e) => e.commit)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
    expect(f.content.keyBlocks[1]![1]).toBe(pad(2000))
    await v3.verifyFile(store, f.key, { labeled: true })
  })
})

describe('determinism', () => {
  it('gives one file id whatever the gzip level, concurrency, or line form', async () => {
    const rows = manyRows(4000, 500)
    const base = await v3.writeFileBytes(rows)
    for (const opts of [{ level: 1 }, { level: 9 }, { concurrency: 1 }, { concurrency: 16 }]) {
      const other = await v3.writeFileBytes(rows, opts)
      expect(other.id).toBe(base.id)
      expect(other.content).toEqual(base.content)
    }
    const fast = await v3.writeFileBytes(rows, { level: 1 })
    expect(fast.size).not.toBe(base.size)
    const enc = new TextEncoder()
    const asBytes = rows.map((r) =>
      r.kind === 'w' ? r : { ...r, line: enc.encode(r.line as string) },
    )
    expect((await v3.writeFileBytes(asBytes)).id).toBe(base.id)
  })

  it('reads a file whose blocks were compressed by another compressor', async () => {
    // Re-compress every block with the Web Streams compressor and rebuild the locator.
    const store = memoryStore()
    const f = await putFile(store, manyRows(3000, 400))
    const file = await v3.SortedFile.open(store, f.key)
    const all = (await (await store.get(f.key))!.bytes()) as Uint8Array
    const parts: Uint8Array[] = []
    const locator: v3.FileLocator = { recordBlocks: [], keyBlocks: [] }
    for (const [offsets, into] of [
      [file.recordOffsets, locator.recordBlocks],
      [file.keyOffsets, locator.keyBlocks],
    ] as const) {
      for (let i = 0; i < offsets.length - 1; i++) {
        const raw = await v3.gunzipMember(all.subarray(offsets[i]!, offsets[i + 1]!), 1 << 30)
        const gz = await gzip(raw)
        parts.push(gz)
        into.push(gz.byteLength)
      }
    }
    const footer = await gzip(v3.footerBytes(file.content, locator))
    parts.push(footer, v3.trailerBytes(footer.byteLength))
    await store.put('records/other', v3.concatBytes(parts))
    expect((await v3.verifyFile(store, 'records/other', { canonical: true })).id).toBe(f.id)
  })

  it('same rows, same id (property)', async () => {
    const row = fc.record({
      type: fc.constantFrom('a', 'b', 'c d', 'é'),
      id: fc.string({ minLength: 1, maxLength: 12, unit: 'grapheme' }),
      data: fc.jsonValue({ maxDepth: 2 }),
      removed: fc.boolean(),
    })
    await fc.assert(
      fc.asyncProperty(fc.array(row, { maxLength: 60 }), async (input) => {
        const byKey = new Map<string, v3.WriteRow>()
        for (const r of input) {
          // Through the input rules, as an upload goes; lines they refuse are left out.
          try {
            const row = v3.parseInputLine(
              JSON.stringify(
                r.removed
                  ? { id: r.id, type: r.type, removed: true }
                  : { id: r.id, type: r.type, data: r.data },
              ),
            )
            byKey.set(JSON.stringify([r.type, r.id]), row)
          } catch (err) {
            if (!(err instanceof InputRuleError)) throw err
          }
        }
        const rows = sortRows([...byKey.values()])
        const a = await v3.writeFileBytes(rows, { level: 1, concurrency: 1 })
        const b = await v3.writeFileBytes(rows, { level: 9, concurrency: 3 })
        expect(a.id).toBe(b.id)
        const store = memoryStore()
        await store.put('f', a.bytes)
        expect((await v3.verifyFile(store, 'f', { canonical: true })).id).toBe(a.id)
      }),
      { numRuns: 40 },
    )
  })
})

describe('verifying', () => {
  it('accepts a good file, in ranges of any size', async () => {
    const store = memoryStore()
    const f = await putFile(store, manyRows(6000, 700))
    for (const rangeBlocks of [1, 2, 100]) {
      const v = await v3.verifyFile(store, f.key, { id: f.id, canonical: true, rangeBlocks })
      expect(v.content).toEqual(f.content)
    }
  })

  /** Rebuild a file from its parts, with one part changed. */
  async function tampered(
    rows: v3.WriteRow[],
    change: (p: {
      records: Uint8Array[]
      keys: Uint8Array[]
      content: v3.FileContent
    }) => void | Promise<void>,
    opts: v3.WriterOptions = {},
  ) {
    const store = memoryStore()
    const f = await putFile(store, rows, opts)
    const file = await v3.SortedFile.open(store, f.key)
    const all = (await (await store.get(f.key))!.bytes()) as Uint8Array
    const read = async (offsets: number[]) => {
      const out: Uint8Array[] = []
      for (let i = 0; i < offsets.length - 1; i++) {
        out.push(
          (await v3.gunzipMember(all.subarray(offsets[i]!, offsets[i + 1]!), 1 << 30)).slice(),
        )
      }
      return out
    }
    const p = {
      records: await read(file.recordOffsets),
      keys: await read(file.keyOffsets),
      content: structuredClone(file.content),
    }
    await change(p)
    const parts: Uint8Array[] = []
    const locator: v3.FileLocator = { recordBlocks: [], keyBlocks: [] }
    for (const raw of p.records) {
      const gz = await v3.gzipMember(raw)
      parts.push(gz)
      locator.recordBlocks.push(gz.byteLength)
    }
    for (const raw of p.keys) {
      const gz = await v3.gzipMember(raw)
      parts.push(gz)
      locator.keyBlocks.push(gz.byteLength)
    }
    const footer = await v3.gzipMember(v3.footerBytes(p.content, locator))
    parts.push(footer, v3.trailerBytes(footer.byteLength))
    await store.put('records/tampered', v3.concatBytes(parts))
    return { store, id: f.id, key: 'records/tampered' }
  }

  const enc = new TextEncoder()
  /** Re-hash key blocks into the content, as a forger who controls the footer would. */
  const rehash = (p: { keys: Uint8Array[]; content: v3.FileContent }) => {
    p.keys.forEach((k, i) => (p.content.keyBlocks[i]![2] = sha256Hex(k)))
  }

  it('rejects a changed record byte', async () => {
    const t = await tampered(manyRows(3000), (p) => {
      const block = p.records[1]!
      block[100] = block[100]! ^ 1
    })
    await expect(v3.verifyFile(t.store, t.key, { id: t.id })).rejects.toThrow(v3.FormatError)
    // A reader of the damaged line is refused too.
    const r = (await v3.SortedFile.open(t.store, t.key, { id: t.id })).reader()
    let refused = 0
    for (const b of [0, 1, 2]) {
      for (const e of await r.keyBlock(b)) await r.line(e).catch(() => refused++)
    }
    expect(refused).toBe(1)
  })

  it('rejects a changed key block, and a footer that does not match the id', async () => {
    const t = await tampered(manyRows(3000), (p) => {
      p.keys[0] = enc.encode(dec.decode(p.keys[0]!).replace('"000001"', '"000001x"'))
    })
    await expect(v3.verifyFile(t.store, t.key, { id: t.id })).rejects.toThrow(/key block 0/)
    const forged = await tampered(manyRows(3000), (p) => {
      p.keys[0] = enc.encode(dec.decode(p.keys[0]!).replace('"000001"', '"000001x"'))
      rehash(p)
    })
    await expect(v3.verifyFile(forged.store, forged.key, { id: forged.id })).rejects.toThrow(
      /file id/,
    )
    // Without the expected id the forged footer is self-consistent, but the line is not the entry's.
    await expect(v3.verifyFile(forged.store, forged.key)).rejects.toThrow(/record its entry names/)
  })

  it('rejects entries out of order, lines out of place, and blocks cut wrongly', async () => {
    const swap = await tampered(manyRows(200), (p) => {
      const lines = dec.decode(p.keys[0]!).split('\n')
      ;[lines[3], lines[4]] = [lines[4]!, lines[3]!]
      p.keys[0] = enc.encode(lines.join('\n'))
      rehash(p)
    })
    await expect(v3.verifyFile(swap.store, swap.key)).rejects.toThrow(/order|cut rule/)

    const moved = await tampered(manyRows(200), (p) => {
      // Drop the second line and its entry's claim on the space: positions no longer follow.
      const lines = dec.decode(p.keys[0]!).split('\n')
      lines.splice(1, 1)
      p.keys[0] = enc.encode(lines.join('\n'))
      p.content.entries--
      p.content.keyBlocks[0]![3] = p.content.entries
      rehash(p)
    })
    await expect(v3.verifyFile(moved.store, moved.key)).rejects.toThrow(/cut rule/)

    const extra = await tampered(manyRows(200), (p) => {
      p.records[0] = v3.concatBytes([p.records[0]!, enc.encode('{"extra":1}\n')])
    })
    await expect(v3.verifyFile(extra.store, extra.key)).rejects.toThrow(/after the last line/)

    const counts = await tampered(manyRows(200), (p) => {
      p.content.records++
    })
    await expect(v3.verifyFile(counts.store, counts.key)).rejects.toThrow(/footer records/)
  })

  it('rejects a record that is not canonical, and one that breaks an input rule', async () => {
    const rows = [rec('t', 'a', { b: 1, a: 2 })]
    const bad = await tampered(rows, (p) => {
      const line = '{"id":"a","type":"t","data":{"b":1,"a":2}}'
      p.records[0] = enc.encode(line + '\n')
      const e: v3.Entry = {
        kind: 'r',
        type: 't',
        id: 'a',
        hash: sha256Hex(line),
        size: line.length,
        block: 0,
        offset: 0,
      }
      p.keys[0] = enc.encode(v3.entryText(e) + '\n')
      p.content.bytes = line.length + 1
      rehash(p)
    })
    await v3.verifyFile(bad.store, bad.key)
    await expect(v3.verifyFile(bad.store, bad.key, { canonical: true })).rejects.toThrow(
      /not canonical/,
    )
  })

  it('rejects a reserved type that is not one of the three', async () => {
    const store = memoryStore()
    const f = await putFile(store, [rec('$other', 'a', 1)])
    await expect(v3.verifyFile(store, f.key)).rejects.toThrow(/reserved/)
  })

  it('rejects a block that inflates past its limit, and a footer too long to read', async () => {
    // A few hundred KB of zeros that inflate to 64 MiB, as a record block.
    const bomb = await tampered(manyRows(10), (p) => {
      p.records[0] = new Uint8Array(64 * 1024 * 1024)
    })
    const r = (await v3.SortedFile.open(bomb.store, bomb.key)).reader()
    await expect(r.recordBlock(0)).rejects.toThrow(/inflates past/)
    await expect(v3.verifyFile(bomb.store, bomb.key)).rejects.toThrow(v3.FormatError)
    await expect(v3.gunzipMember(await gzip(new Uint8Array(4096)), 1024)).rejects.toThrow(
      /inflates past 1024 bytes/,
    )
    await expect(v3.gunzipMember(new Uint8Array(64), 1024)).rejects.toThrow(/does not inflate/)
    // A member whose trailer understates its length stops at the limit all the same; an
    // honest one of any size within the limit inflates whole.
    const lying = (await gzip(new Uint8Array(4 * 1024 * 1024))).slice()
    new DataView(lying.buffer).setUint32(lying.byteLength - 4, 10, true)
    await expect(v3.gunzipMember(lying, 1024 * 1024)).rejects.toThrow(v3.FormatError)
    for (const size of [0, 1, 65_535, 65_536, 65_537, 111_338, 300_000]) {
      const raw = new Uint8Array(size).map((_, i) => (i * 31 + (i >> 3)) & 0xff)
      expect(await v3.gunzipMember(await gzip(raw), 1024 * 1024)).toEqual(raw)
    }
    // A trailer that claims a footer of 2^60 bytes: refused before anything more is read.
    const store = memoryStore()
    const f = await putFile(store, manyRows(10))
    const all = ((await (await store.get(f.key))!.bytes()) as Uint8Array).slice()
    new DataView(all.buffer).setBigUint64(all.byteLength - 8, 1n << 60n, false)
    await store.put('long', all)
    await expect(v3.SortedFile.open(store, 'long')).rejects.toThrow(/footer too long/)
  })

  it('bounds what a footer parses into, and a key block its lines, before either is read', async () => {
    const store = memoryStore()
    const f = await putFile(store, manyRows(10))
    const all = (await (await store.get(f.key))!.bytes()) as Uint8Array
    const file = await v3.SortedFile.open(store, f.key)
    const body = all.subarray(0, file.keyOffsets[file.keyOffsets.length - 1]!)
    const withFooter = async (name: string, json: string) => {
      const footer = await v3.gzipMember(new TextEncoder().encode(json))
      await store.put(name, v3.concatBytes([body, footer, v3.trailerBytes(footer.byteLength)]))
      return v3.SortedFile.open(store, name)
    }
    // 4M array elements in 8 MiB of JSON: refused by counting, never handed to JSON.parse.
    const many = `{"content":{},"locator":{"recordBlocks":[${'1,'.repeat(4 * 1024 * 1024)}1],"keyBlocks":[]}}`
    await expect(withFooter('many', many)).rejects.toThrow(/more elements than a file can/)
    // Commas inside strings are not elements: a footer whose only long member is a string of
    // them gets as far as its shape.
    const commas = `{"content":{"x":"${','.repeat(2 * 1024 * 1024)}"},"locator":{}}`
    await expect(withFooter('commas', commas)).rejects.toThrow(/bad footer/)
    // A footer that inflates past 16 MiB: refused while inflating.
    const big = `{"content":{"x":"${'a'.repeat(17 * 1024 * 1024)}"},"locator":{}}`
    await expect(withFooter('big', big)).rejects.toThrow(/inflates past/)
    // A key block of 4,096 lines, its hash put in the footer as a forger would.
    const lines = await tampered(manyRows(10), (p) => {
      p.keys[0] = new Uint8Array(4096).fill(0x0a)
    })
    const r = (await v3.SortedFile.open(lines.store, lines.key)).reader()
    await expect(r.keyBlock(0)).rejects.toThrow(/more than 1024 entries/)
    await expect(r.keyBlockText(0)).rejects.toThrow(/more than 1024 entries/)
  })

  it('rejects a byte-order mark, in a line or a key block, and text that is not UTF-8', async () => {
    const BOM = [0xef, 0xbb, 0xbf]
    // The line is the canonical record after a BOM: a lenient decoder would drop it and
    // find the record canonical, while its hash and size are over other bytes.
    const line = await tampered([rec('t', 'a', { n: 1 })], (p) => {
      const text = '{"id":"a","type":"t","data":{"n":1}}'
      const bytes = new Uint8Array([...BOM, ...enc.encode(text)])
      p.records[0] = new Uint8Array([...bytes, 0x0a])
      const e: v3.Entry = {
        kind: 'r',
        type: 't',
        id: 'a',
        hash: sha256Hex(bytes),
        size: bytes.byteLength,
        block: 0,
        offset: 0,
      }
      p.keys[0] = enc.encode(v3.entryText(e) + '\n')
      p.content.bytes = bytes.byteLength + 1
      rehash(p)
    })
    await expect(v3.verifyFile(line.store, line.key, { canonical: true })).rejects.toThrow(
      InputRuleError,
    )
    const keys = await tampered(manyRows(10), (p) => {
      p.keys[0] = new Uint8Array([...BOM, ...p.keys[0]!])
      rehash(p)
    })
    await expect(v3.verifyFile(keys.store, keys.key)).rejects.toThrow(v3.FormatError)
    const raw = await tampered(manyRows(10), (p) => {
      const at = p.keys[0]!.indexOf(0x30)
      p.keys[0]![at] = 0xff
      rehash(p)
    })
    await expect(v3.verifyFile(raw.store, raw.key)).rejects.toThrow(/not UTF-8/)
  })

  it('rejects an empty file that counts rows, and bytes its footer does not cover', async () => {
    const counts = await tampered([], (p) => {
      p.content.records = 1_000_000
      p.content.removals = 77
    })
    await expect(v3.verifyFile(counts.store, counts.key)).rejects.toThrow(/counts nothing/)
    // Junk before a file that the tail read never reaches.
    const store = memoryStore()
    const f = await putFile(store, manyRows(2000))
    const all = (await (await store.get(f.key))!.bytes()) as Uint8Array
    await store.put('padded', v3.concatBytes([new Uint8Array(1 << 20), all]))
    await expect(v3.verifyFile(store, 'padded')).rejects.toThrow(/length does not match/)
  })

  it('refuses a key with a lone surrogate, a type before the reserved ones, and __proto__', () => {
    expect(v3.checkKey('t', 'a\ud800')).toMatch(/lone surrogate/)
    expect(() => v3.removalRow('a\ud800', 't')).toThrow(InputRuleError)
    for (const type of [' a', '!a', '"a', '#a'])
      expect(v3.checkKey(type, 'a')).toMatch(/before "\$"/)
    expect(v3.checkKey('%a', 'a')).toBe(null)
    expect(v3.checkKey('__proto__', 'a')).toMatch(/reserved/)
    expect(v3.checkKey(v3.SCHEMA_TYPE, '__proto__')).toMatch(/type name/)
    expect(v3.checkKey(v3.SCHEMA_TYPE, '#a')).toMatch(/type name/)
  })

  it('rejects a truncated file and a bad trailer', async () => {
    const store = memoryStore()
    const f = await putFile(store, manyRows(100))
    const all = (await (await store.get(f.key))!.bytes()) as Uint8Array
    await store.put('short', all.subarray(0, all.byteLength - 5))
    await expect(v3.SortedFile.open(store, 'short')).rejects.toThrow(v3.FormatError)
    await store.put('tiny', all.subarray(0, 8))
    await expect(v3.SortedFile.open(store, 'tiny')).rejects.toThrow(/too short/)
    await store.put('cut', all.subarray(20))
    await expect(v3.SortedFile.open(store, 'cut')).rejects.toThrow(/length does not match/)
    await expect(v3.SortedFile.open(store, 'absent')).rejects.toThrow(v3.MissingFileError)
  })
})

describe('lines', () => {
  it('parses upload lines into canonical lines', () => {
    const r = v3.parseInputLine('{"type":"t","data":{"b":1,"a":[2]},"id":"x"}')
    expect(r).toMatchObject({ kind: 'r', type: 't', id: 'x' })
    expect(r.line).toBe('{"id":"x","type":"t","data":{"a":[2],"b":1}}')
    const x = v3.parseInputLine('{"removed":true,"type":"t","id":"x"}')
    expect(x.line).toBe('{"id":"x","removed":true,"type":"t"}')
    expect(v3.lineKey(r.line)).toEqual({ kind: 'r', type: 't', id: 'x' })
    expect(v3.lineKey(x.line)).toEqual({ kind: 'x', type: 't', id: 'x' })
    const odd = v3.parseInputLine('{"id":"a\\"b\\\\","type":"q\\"","data":"{\\"id\\":1}"}')
    expect(v3.lineKey(odd.line)).toEqual({ kind: 'r', type: 'q"', id: 'a"b\\' })
    for (const bad of [
      '{"id":"x","type":"t"}',
      '{"id":"x","type":"t","removed":false}',
      '{"id":"x","type":"t","removed":true,"data":1}',
      '{"id":"x","type":"t","data":1,"extra":2}',
      '{"id":"x","type":"$nope","data":1}',
      '{"id":"x","type":"$meta","data":1}',
      '{"id":"$x","type":"$schema","data":{}}',
      '{"id":"abc","type":"$asset","data":{}}',
      '[1]',
    ]) {
      expect(() => v3.parseInputLine(bad), bad).toThrow()
    }
    expect(v3.parseInputLine('{"id":"collection","type":"$meta","data":{}}').kind).toBe('r')
    expect(v3.parseInputLine('{"id":"work","type":"$schema","data":{}}').kind).toBe('r')
  })

  it('orders keys by type, then id, as UTF-8 bytes', () => {
    expect(v3.compareKeys('a', 'z', 'b', 'a')).toBeLessThan(0)
    expect(v3.compareKeys('a', 'b', 'a', 'a')).toBeGreaterThan(0)
    expect(v3.compareKeys('a', '\u{10000}', 'a', '￿')).toBeGreaterThan(0)
    expect(v3.compareKeys('$schema', 'x', 'a', 'a')).toBeLessThan(0)
  })
})

interface VectorCase {
  name: string
  labeled: boolean
  rows?: v3.WriteRow[]
  generated?: { count: number; repeat: number }
  id: string
  content: v3.FileContent
}
/** The rule the vectors file states for its long cases. */
const generatedRows = (g: { count: number; repeat: number }) =>
  Array.from({ length: g.count }, (_, i) =>
    rec(
      't',
      String(i).padStart(4, '0'),
      g.repeat ? { text: 'abcdefghij'.repeat(g.repeat), n: i } : i,
    ),
  )

describe('test vectors', () => {
  it('builds every vector to its recorded file id and content', async () => {
    expect(vectors.cases.length).toBeGreaterThan(3)
    for (const c of vectors.cases as VectorCase[]) {
      const rows = c.rows ?? generatedRows(c.generated!)
      const f = await v3.writeFileBytes(rows, { labeled: c.labeled, level: 1 })
      expect(f.id, c.name).toBe(c.id)
      expect(f.content, c.name).toEqual(c.content)
    }
  })
})

// Keeps the seeded generator in use by the other v3 tests honest.
it('rng is deterministic', () => {
  const a = rng(1)
  const b = rng(1)
  expect([a(), a(), a()]).toEqual([b(), b(), b()])
})
