/**
 * Memory of a commit's planning at full size, without the data: run summaries
 * as a 1 TB push of ~6.5 KB records leaves them (32 runs, 50,000 parts of 4 MB,
 * a mark every 8,192 entries), parsed from JSON as the planner and each plan
 * chunk read them, then split into units and sliced as they do.
 *
 *   node --expose-gc --import tsx scripts/plan-memory.ts [--parts N] [--runs N]
 */
import { compareUtf8 } from '@underlay/protocol'

import { parallelConfig, planRanges } from '../src/push/parallel.js'
import {
  normalizeIndex,
  type RunIndex,
  type RunPart,
  runMarks,
  sliceRun,
} from '../src/push/runs.js'

const args = process.argv.slice(2)
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : def
}
const PARTS = opt('parts', 50_000)
const RUNS = opt('runs', 32)
const gc = (globalThis as { gc?: () => void }).gc!
const MB = 1024 * 1024
const live = () => {
  gc()
  const m = process.memoryUsage()
  return m.heapUsed + m.arrayBuffers
}

// Keys: DOIs spread evenly, each run covering the whole key space (uploads in random order).
const doi = (n: number) => `10.${1000 + (n % 9000)}/${n.toString(36).padStart(10, '0')}`
const perRun = Math.ceil(PARTS / RUNS)
const texts: string[] = []
for (let r = 0; r < RUNS; r++) {
  const parts: RunPart[] = []
  const keys = Array.from({ length: perRun + 1 }, (_, i) => doi(i * RUNS + r)).sort(compareUtf8)
  for (let i = 0; i < perRun; i++) {
    parts.push({
      part: i,
      first: `journal-article\u0000${keys[i]}`,
      last: `journal-article\u0000${keys[i + 1]}`,
      count: 3200,
      bytes: 20 * MB,
      length: 4 * MB,
      ...(i % 3 === 0 ? { marks: [`journal-article\u0000${keys[i]}x`] } : {}),
    })
  }
  texts.push(JSON.stringify({ v: 2, seq: r + 1, tier: 3, parts }))
}
const textMB = texts.reduce((n, t) => n + t.length, 0) / MB

const base = live()
const runs: RunIndex[] = texts.map((t) => normalizeIndex(JSON.parse(t)))
const parsed = live() - base
const parts = runs.flatMap((ix) => ix.parts)
const marks = runMarks(runs, { type: 'journal-article' }).map((m) =>
  m.slice(m.indexOf('\u0000') + 1),
)
const ranges = planRanges(
  'journal-article',
  marks,
  parts,
  { nodes: [], leafBytes: 0 },
  parallelConfig.unitBytes,
)
const planned = live() - base
let sliceBytes = 0
for (const r of ranges.slice(0, 50))
  for (const ix of runs)
    sliceBytes += JSON.stringify(sliceRun(ix, { type: 'journal-article', ...r })).length
console.log(
  JSON.stringify({
    runs: RUNS,
    parts: PARTS,
    summaryJsonMB: +textMB.toFixed(1),
    parsedMB: +(parsed / MB).toFixed(1),
    plannedMB: +(planned / MB).toFixed(1),
    units: ranges.filter((r) => !r.gap).length,
    sliceKB: +(sliceBytes / 50 / 1024).toFixed(1),
  }),
)
