/**
 * Getting a large commit through after it failed (staging, 2026-10-16): units
 * capped by entries as well as bytes, and a commit that rebases on the head.
 */
import {
  buildTree,
  compareUtf8,
  fixedChunking,
  hashRecord,
  MapSource,
  MemorySink,
  type NodeDesc,
  type RecordEntry,
  recordTree,
  utf8ByteLength,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { baseLevelFor, expandHeavyNodes, parallelConfig, planRanges } from '../src/push/parallel.js'
import type { RunPart } from '../src/push/runs.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)
const defaults = { ...parallelConfig }
afterEach(() => void Object.assign(parallelConfig, defaults))

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const rec = (id: string) => ({ id, type: 'Author', data: { name: id } })

async function json(res: Response) {
  return (await res.json()) as any
}

describe('unit planning', () => {
  const candidates = Array.from({ length: 9 }, (_, i) => `k${i + 1}`)
  // One part of 1,000 tiny entries across the whole key range.
  const part: RunPart = {
    part: 0,
    first: 'Author\u0000k0',
    last: 'Author\u0000k9z',
    count: 1_000,
    bytes: 1_000,
    length: 100,
  }
  const base = { nodes: [], leafBytes: 1 }

  it('closes a unit at the entry cap when bytes are far under theirs', () => {
    const units = (cap?: number) =>
      planRanges('Author', candidates, [part], base, 1e12, cap).filter((r) => !r.gap)
    expect(units()).toHaveLength(1)
    expect(units(300)).toHaveLength(4)
  })

  it('reads base nodes of about 64 leaves for a Crossref-sized type', () => {
    // 110M entries: level 1 has ~1,678 nodes, under baseNodes.
    expect(baseLevelFor(110_000_000)).toBe(1)
    expect(baseLevelFor(50_000 * 1024 * 64 + 1)).toBe(2)
  })

  it('reads heavy level-1 nodes, heaviest first, and puts their leaves in their place', async () => {
    // A small tree of three ranges: light, heavy, light records.
    const chunking = fixedChunking({ leafBits: 2, stepBits: 1, leafMax: 8, interiorMax: 4 }, 'tiny')
    const entries = Array.from({ length: 600 }, (_, i) => {
      const id = `r${String(i).padStart(4, '0')}`
      const heavy = i >= 200 && i < 400
      const { hash, canonical } = hashRecord(id, 'Author', { name: id })
      return {
        key: id,
        hash,
        size: heavy ? 50 * utf8ByteLength(canonical) : utf8ByteLength(canonical),
      }
    })
    const sink = new MemorySink<RecordEntry>()
    const root = buildTree(recordTree, sink, entries, { chunking })!
    const source = new MapSource(recordTree, sink.nodes)
    const level1: NodeDesc[] = []
    const walk = async (d: NodeDesc): Promise<void> => {
      if (d.level === 1) return void level1.push(d)
      const n = await source.node(d.hash)
      if (n.kind === 'node') for (const c of n.children) await walk(c)
    }
    await walk(root)
    expect(level1.length).toBeGreaterThan(20)
    const reads: string[] = []
    const counting = { node: (h: string) => (reads.push(h), source.node(h)) }
    const treeLeaf = (root.bytes / root.count) * 1024
    const meanLeaf = (d: NodeDesc) => d.bytes / (d.count / 1024)
    const heavy = level1.filter((d) => meanLeaf(d) > 1.5 * treeLeaf)
    expect(heavy.length).toBeGreaterThan(5)
    expect(heavy.length).toBeLessThan(level1.length / 2)

    Object.assign(parallelConfig, { unitBytes: 1 })
    const out = await expandHeavyNodes(counting, level1, treeLeaf)
    // Only heavy nodes are read; each is replaced by its leaves, in key order.
    expect(new Set(reads)).toEqual(new Set(heavy.map((d) => d.hash)))
    const expected: NodeDesc[] = []
    for (const d of level1) {
      const n = await source.node(d.hash)
      expected.push(...(heavy.includes(d) && n.kind === 'node' ? n.children : [d]))
    }
    expect(out).toEqual(expected)
    expect(out.map((d) => d.lastKey)).toEqual([...out.map((d) => d.lastKey)].sort(compareUtf8))

    // The cap reads the heaviest first.
    reads.length = 0
    Object.assign(parallelConfig, { expandReads: 2 })
    await expandHeavyNodes(counting, level1, treeLeaf)
    const heaviest = [...heavy].sort((a, b) => meanLeaf(b) - meanLeaf(a)).slice(0, 2)
    expect(new Set(reads)).toEqual(new Set(heaviest.map((d) => d.hash)))

    // A node under unitBytes is never read.
    reads.length = 0
    Object.assign(parallelConfig, { unitBytes: Infinity, expandReads: 2_000 })
    expect(await expandHeavyNodes(counting, level1, treeLeaf)).toEqual(level1)
    expect(reads).toEqual([])
  })

  it('keeps units over skewed leaves of large records near the byte budget', async () => {
    // A re-commit of a type like Crossref's works (2026-10-16): 2 MB leaves, then
    // 1,024 leaves of large records (p50 ~30 MB, p90 ~66 MB, up to ~216 MB), every
    // record sent again; base nodes of 64 leaves, marks on every 8th leaf. Records
    // over 64 KB are out of line, so run parts count them as pointer lines.
    const MB = 1024 * 1024
    const LEAF = 1024
    let seed = 7
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31
    const leafMB = (r: number) =>
      r < 0.5 ? 10 + 40 * r : r < 0.9 ? 30 + 90 * (r - 0.5) : 66 + 1500 * (r - 0.9)
    const leafBytes = Array.from({ length: 3072 }, (_, i) =>
      i < 1024 || i >= 2048 ? 2 * MB : Math.round(leafMB(rand()) * MB),
    )
    const key = (i: number) => `k${String(i).padStart(6, '0')}`
    const partBytes = (b: number) => (b / LEAF > 64 * 1024 ? 250 * LEAF : b)
    const parts: RunPart[] = []
    for (let g = 0; g < leafBytes.length; g += 64) {
      parts.push({
        part: g,
        first: `Author\u0000${key(g)}`,
        last: `Author\u0000${key(g + 63)}`,
        count: 64 * LEAF,
        bytes: leafBytes.slice(g, g + 64).reduce((n, b) => n + partBytes(b), 0),
        length: 0,
      })
    }
    const leaf = (i: number): NodeDesc => ({
      level: 0,
      hash: `leaf${i}`,
      lastKey: key(i),
      count: LEAF,
      bytes: leafBytes[i]!,
    })
    const nodes: NodeDesc[] = Array.from({ length: leafBytes.length / 64 }, (_, g) => ({
      level: 1,
      hash: `node${g}`,
      lastKey: key(g * 64 + 63),
      count: 64 * LEAF,
      bytes: leafBytes.slice(g * 64, g * 64 + 64).reduce((n, b) => n + b, 0),
    }))
    const source = {
      node: async (hash: string) =>
        ({
          kind: 'node',
          children: Array.from({ length: 64 }, (_, j) => leaf(Number(hash.slice(4)) * 64 + j)),
        }) as never,
    }
    const marks = leafBytes.map((_, i) => key(i)).filter((_, i) => i % 8 === 7)
    const treeLeaf = leafBytes.reduce((n, b) => n + b, 0) / leafBytes.length
    const plan = (base: NodeDesc[]) => {
      const candidates = [...new Set([...marks, ...base.map((d) => d.lastKey)])]
        .sort(compareUtf8)
        .slice(0, -1)
      return planRanges(
        'Author',
        candidates,
        parts,
        { nodes: base, leafBytes: treeLeaf },
        256 * MB,
        100_000,
      )
        .filter((r) => !r.gap)
        .map((r) => {
          let bytes = 0
          let heavy = false
          for (let i = 0; i < leafBytes.length; i++) {
            if (
              (r.after !== null && key(i) <= r.after) ||
              (r.through !== null && key(i) > r.through)
            )
              continue
            bytes += leafBytes[i]!
            if (i >= 1024 && i < 2048) heavy = true
          }
          return { bytes, heavy }
        })
    }
    const expanded = plan(await expandHeavyNodes(source, nodes, treeLeaf))
    const heavy = expanded
      .filter((u) => u.heavy)
      .map((u) => u.bytes)
      .sort((a, b) => a - b)
    expect(heavy[Math.floor(heavy.length * 0.9)]!).toBeLessThanOrEqual(400 * MB)
    expect(heavy[heavy.length - 1]!).toBeLessThanOrEqual(Math.max(...leafBytes) + 256 * MB)
    // Light ranges are planned as before.
    const light = (units: { heavy: boolean }[]) => units.filter((u) => !u.heavy).length
    const before = light(plan(nodes))
    expect(Math.abs(light(expanded) - before)).toBeLessThanOrEqual(before * 0.05)
  })
})

describe('commit with rebase', () => {
  async function open(h: Harness, user: string, path: string, ids: string[]) {
    const sid = (
      await json(
        await h.request(`${path}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
      )
    ).session_id as string
    const res = await h.request(`${path}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: ids.map(rec),
    })
    expect(res.status).toBe(200)
    return sid
  }

  it('commits a session on a head that moved since it opened', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('moved')
    const path = '/api/collections/org/moved'
    const a = await open(h, user, path, ['a1', 'a2'])
    const b = await open(h, user, path, ['b1'])
    expect(
      (await h.request(`${path}/push/${b}/commit`, { method: 'POST', user, json: {} })).status,
    ).toBe(201)
    // Without rebase the moved base is refused, and the session fails.
    const refused = await h.request(`${path}/push/${a}/commit`, { method: 'POST', user, json: {} })
    expect(refused.status).toBe(409)

    const c = await open(h, user, path, ['c1', 'c2', 'c3'])
    const d = await open(h, user, path, ['d1'])
    await h.request(`${path}/push/${d}/commit`, { method: 'POST', user, json: {} })
    const res = await h.request(`${path}/push/${c}/commit`, {
      method: 'POST',
      user,
      json: { rebase: true },
    })
    expect(res.status).toBe(201)
    expect((await json(res)).recordCount).toBe(5)
  })

  it('rebases a failed session committed again', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('retry')
    const path = '/api/collections/org/retry'
    const a = await open(h, user, path, ['a1', 'a2'])
    // A commit that failed on the server's side (as a unit out of attempts does).
    await h.ports.db
      .update(schema.pushSessions)
      .set({ status: 'failed', error: { statusCode: 500, error: 'A commit unit failed 4 times' } })
      .where(eq(schema.pushSessions.id, a))
    const b = await open(h, user, path, ['b1'])
    await h.request(`${path}/push/${b}/commit`, { method: 'POST', user, json: {} })
    const res = await h.request(`${path}/push/${a}/commit`, {
      method: 'POST',
      user,
      json: { rebase: true },
    })
    expect(res.status).toBe(201)
    expect((await json(res)).recordCount).toBe(3)
  })

  it('refuses a rebase that is not a boolean', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('bad')
    const path = '/api/collections/org/bad'
    const a = await open(h, user, path, ['a1'])
    const res = await h.request(`${path}/push/${a}/commit`, {
      method: 'POST',
      user,
      json: { rebase: 'yes' },
    })
    expect(res.status).toBe(400)
  })
})
