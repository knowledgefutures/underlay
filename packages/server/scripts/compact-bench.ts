/**
 * CPU of one compaction on Crossref works: 16 runs of real works (NDJSON files
 * of Crossref API works in --src, copied under new DOIs to reach --mb), merged into one, in an
 * in-memory store. Prints wall and process CPU (zlib's thread pool included).
 *
 *   node --import tsx scripts/compact-bench.ts --src DIR [--mb 160] [--runs 16] [--raw]
 *
 * --raw writes the input runs uncompressed, as a compaction writes them.
 *   node --cpu-prof --import tsx scripts/compact-bench.ts   (main-thread profile)
 */
import { readdirSync, readFileSync } from 'node:fs'

import { MemoryStore, sha256Hex } from '@underlay/protocol'

import { compactRuns, type RunEntry, type RunIndex, runKey, RunWriter } from '../src/push/runs.js'

const args = process.argv.slice(2)
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1]! : def
}
const MB = Number(opt('mb', '160'))
const RUNS = Number(opt('runs', '16'))
const SRC = opt('src', '')
if (!SRC) throw new Error('--src DIR: a directory of Crossref works as NDJSON')
const RAW = args.includes('--raw')

const works: Record<string, unknown>[] = []
for (const f of readdirSync(SRC).sort()) {
  for (const line of readFileSync(`${SRC}/${f}`, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const w = JSON.parse(line) as { message?: Record<string, unknown> }
    works.push((w.message ?? w) as Record<string, unknown>)
  }
}
const entries: RunEntry[] = []
let bytes = 0
for (let copy = 0; bytes < MB * 1e6; copy++) {
  for (const w of works) {
    const k = `${String(w.DOI)}/${copy}`
    const t = String(w.type ?? 'journal-article')
    const b = JSON.stringify({ id: k, type: t, data: w })
    const e = { t, k, h: sha256Hex(b), s: b.length, b }
    entries.push(e)
    bytes += JSON.stringify(e).length + 1
    if (bytes >= MB * 1e6) break
  }
}
const store = new MemoryStore()
const sid = 'bench'
const runs: RunEntry[][] = Array.from({ length: RUNS }, () => [])
entries.forEach((e, i) => runs[i % RUNS]!.push(e))
const indexes: RunIndex[] = []
for (let r = 0; r < RUNS; r++) {
  const w = new RunWriter(store, sid, r + 1, 0, { raw: RAW })
  for (const e of runs[r]!.sort((a, b) => (runKey(a) < runKey(b) ? -1 : 1))) {
    w.add(e)
    await w.drain()
  }
  indexes.push(await w.finish())
}
process.stdout.write(`${entries.length} entries, ${(bytes / 1e6).toFixed(0)} MB, ${RUNS} runs\n`)

const cpu0 = process.cpuUsage()
const t0 = performance.now()
const out = await compactRuns(store, sid, indexes, RUNS + 1, 1)
const wall = (performance.now() - t0) / 1000
const cpu = process.cpuUsage(cpu0)
const cpuS = (cpu.user + cpu.system) / 1e6
process.stdout.write(
  `compacted ${out.parts.length} parts in ${wall.toFixed(1)} s wall, ${cpuS.toFixed(1)} s CPU: ` +
    `${(bytes / 1e6 / cpuS).toFixed(0)} MB per CPU-second\n`,
)
