/**
 * Tree-parameter experiment: the protocol's fixed-probability chunker against a
 * size-aware one (Dolt-style, Weibull-shaped split hazard).
 *
 *   pnpm tsx scripts/experiment-chunking.ts [N]
 *
 * Boundaries depend on SHA-256 of keys, so leaf sizes are distributed the same
 * way for any key set; synthetic ids are enough for shape. What real collections
 * add (id lengths, record sizes) is measured separately.
 *
 * Reports, per chunker: leaf size spread, node counts per level, height, forced
 * splits, and write amplification (nodes written) for single updates, single
 * inserts, random batches and appends.
 */
import { createHash } from 'node:crypto'

import {
  buildTree,
  type Change,
  type Chunking,
  compareUtf8,
  MapSource,
  mergeTree,
  type NodeDesc,
  protocolChunking,
  type RecordEntry,
  recordTree,
  sha256Hex,
  type TreeSink,
} from '../src/index.js'

const N = Number(process.argv[2] ?? 1_000_000)

/** Size-aware: split hazard from a Weibull(k=4) target with the given mean. */
function sizeAware(
  leafMean: number,
  fanoutMean: number,
  leafMax: number,
  interiorMax: number,
): Chunking {
  const k = 4
  const gamma = 0.9064024770554771 // Γ(1 + 1/4)
  const hazard = (mean: number) => {
    const lambda = mean / gamma
    const table: number[] = [0]
    for (let s = 1; s <= 8 * mean; s++) {
      const a = Math.pow((s - 1) / lambda, k)
      const b = Math.pow(s / lambda, k)
      table.push(1 - Math.exp(-(b - a)))
    }
    return (s: number) => table[s] ?? 1
  }
  const leafH = hazard(leafMean)
  const nodeH = hazard(fanoutMean)
  return {
    name: `size-aware(${leafMean},${fanoutMean})`,
    ends(level, u, size) {
      if (level === 0 && size >= leafMax) return true
      if (level > 0 && size >= interiorMax) return true
      // A uniform draw per level from the key's hash (u is its first 8 bytes;
      // derive more bits per level from it).
      const d = createHash('sha256').update(u).update(String(level)).digest()
      const r = d.readUInt32BE(0) / 2 ** 32
      return r < (level === 0 ? leafH(size) : nodeH(size))
    },
  }
}

const idOf = (i: number) => `W${(i * 2654435761) % 4294967296}`.padEnd(12, 'x') + i
const entry = (key: string, v = 0): RecordEntry => ({
  key,
  hash: sha256Hex(`${key}:${v}`),
  size: 600,
})

class StatsSink implements TreeSink<RecordEntry> {
  nodes = new Map<string, string>()
  leaves = new Map<string, readonly RecordEntry[]>()
  written = 0
  leafSizes: number[] = []
  perLevel: number[] = []
  forced = 0
  constructor(private readonly leafMax: number) {}
  leaf(desc: NodeDesc, json: string, entries: readonly RecordEntry[]) {
    this.written++
    this.nodes.set(desc.hash, json)
    this.leaves.set(desc.hash, entries)
    this.leafSizes.push(entries.length)
    this.perLevel[0] = (this.perLevel[0] ?? 0) + 1
    if (entries.length >= this.leafMax) this.forced++
  }
  interior(desc: NodeDesc, json: string) {
    this.written++
    this.nodes.set(desc.hash, json)
    this.perLevel[desc.level] = (this.perLevel[desc.level] ?? 0) + 1
  }
}

const pct = (xs: number[], p: number) =>
  xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!

async function run(chunking: Chunking, leafMax: number) {
  const keys = Array.from({ length: N }, (_, i) => idOf(i)).sort(compareUtf8)
  const sink = new StatsSink(leafMax)
  const t0 = performance.now()
  const root = buildTree(
    recordTree,
    sink,
    keys.map((k) => entry(k)),
    { chunking },
  )!
  const buildMs = performance.now() - t0
  const sizes = sink.leafSizes.slice().sort((a, b) => a - b)
  const perLevel = sink.perLevel.slice()
  const forced = sink.forced
  const source = new MapSource(recordTree, sink.nodes, sink.leaves)

  const amp = async (label: string, makeChanges: () => Change<RecordEntry>[], trials: number) => {
    let total = 0
    for (let t = 0; t < trials; t++) {
      const before = sink.written
      await mergeTree(source, sink, root.hash, makeChanges(), { chunking })
      total += sink.written - before
    }
    return `${label}: ${(total / trials).toFixed(1)}`
  }
  let seed = 12345
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = () => keys[Math.floor(rand() * keys.length)]!
  const sortC = (cs: Change<RecordEntry>[]) => cs.sort((a, b) => compareUtf8(a.key, b.key))
  const results = [
    await amp(
      '1 update',
      () =>
        [{ key: pick(), entry: entry(pick(), 1) }].map((c) => ({
          key: c.key,
          entry: entry(c.key, 1),
        })),
      50,
    ),
    await amp(
      '1 insert',
      () => {
        const k = `${pick()}~new`
        return [{ key: k, entry: entry(k) }]
      },
      50,
    ),
    await amp('1 delete', () => [{ key: pick(), entry: null }], 50),
    await amp(
      '1k random updates',
      () => {
        const ks = new Set<string>()
        while (ks.size < 1000) ks.add(pick())
        return sortC([...ks].map((k) => ({ key: k, entry: entry(k, 2) })))
      },
      5,
    ),
    await amp(
      '10k appends',
      () =>
        Array.from({ length: 10_000 }, (_, i) => `zzzz${String(i).padStart(6, '0')}`).map((k) => ({
          key: k,
          entry: entry(k),
        })),
      3,
    ),
  ]
  const leafNodeBytes = [...sink.leaves.keys()].slice(0, 2000).map((h) => sink.nodes.get(h)!.length)
  const meanLeafBytes = leafNodeBytes.reduce((a, b) => a + b, 0) / leafNodeBytes.length
  console.log(`\n## ${chunking.name}, N=${N.toLocaleString()}`)
  console.log(
    `build: ${(buildMs / 1000).toFixed(1)} s (${((buildMs * 1000) / N).toFixed(2)} µs/entry), height ${root.level + 1}`,
  )
  console.log(`nodes per level: ${perLevel.map((n, l) => `L${l}=${n}`).join(' ')}`)
  console.log(
    `leaf entries: mean ${(N / sizes.length).toFixed(0)}, p1 ${pct(sizes, 1)}, p10 ${pct(sizes, 10)}, p50 ${pct(sizes, 50)}, p90 ${pct(sizes, 90)}, p99 ${pct(sizes, 99)}, max ${sizes[sizes.length - 1]}; <100: ${((100 * sizes.filter((s) => s < 100).length) / sizes.length).toFixed(1)}%, >3×mean: ${((100 * sizes.filter((s) => s > 3 * (N / sizes.length)).length) / sizes.length).toFixed(1)}%; forced ${forced}`,
  )
  console.log(`leaf node JSON: mean ${(meanLeafBytes / 1024).toFixed(0)} KB`)
  console.log(`nodes written per commit (mean): ${results.join(' · ')}`)
}

await run(protocolChunking, 8_192)
await run(sizeAware(1024, 64, 8_192, 1024), 8_192)
