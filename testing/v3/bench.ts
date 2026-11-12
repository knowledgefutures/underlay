/**
 * The v3 scale bench: suites of scenarios, each saved as a result.
 *
 *   H="--max-old-space-size=96 --max-semi-space-size=8"    (a heap of at most 120 MB in all)
 *   node $H --import tsx v3/bench.ts suite gate
 *   node $H --import tsx v3/bench.ts suite 1m --latency r2
 *   node $H --import tsx v3/bench.ts suite many --collections 3000 --burst 300
 *   node --import tsx v3/bench.ts report
 *
 * Suites: gate (20k records, no latency, every scenario small), quick (100k), 1m, 5m, 12m,
 * many (20,000 collections and a burst of 2,000), racing, and crossref (the sorted dump).
 * The heap cap is the bench's memory limit: every process a suite starts runs under it.
 *
 * Bulk goes under ~/underlay-bench/v3 (or $UL_BENCH_DIR/v3); results in its results/ folder.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { cpus, hostname, totalmem } from 'node:os'
import { join } from 'node:path'
import { getHeapStatistics } from 'node:v8'

import { v3 } from '../../packages/protocol/src/index.js'
import { benchDir } from '../src/dirs.js'
import * as API from './api.js'
import { log, parseArgs } from './lib.js'
import { readResults, writeReport } from './report.js'
import * as S from './scenarios.js'
import { runJob } from './workers.js'
import { type World, world } from './world.js'

declare const __BENCH_COMMIT__: string | undefined

function commitId(): string {
  if (typeof __BENCH_COMMIT__ === 'string') return __BENCH_COMMIT__
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

const args = parseArgs(process.argv.slice(2))
const num = (name: string, fallback: number) =>
  typeof args[name] === 'string' ? Number(args[name]) : fallback
const str = (name: string, fallback: string) =>
  typeof args[name] === 'string' ? (args[name] as string) : fallback

function save(w: World, scenario: string, label: string, data: S.Result, seconds: number): void {
  const name = `${w.suite}.${scenario}${label ? `.${label}` : ''}.json`
  const body = {
    suite: w.suite,
    scenario,
    label,
    at: new Date().toISOString(),
    commit: commitId(),
    host: hostname(),
    cpus: cpus().length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    latency: w.latency,
    records: w.records,
    heapCapMb: v8HeapCap(),
    seconds,
    command: process.argv.slice(2).join(' '),
    ...data,
  }
  writeFileSync(join(w.resultsDir, name), JSON.stringify(body, null, 1))
  log(`saved ${name}`)
}

/** The most heap V8 will give this process, in MB: old space and the semi-spaces together. */
function v8HeapCap(): number {
  return Math.round(getHeapStatistics().heap_size_limit / 1024 ** 2)
}

async function step(
  w: World,
  scenario: string,
  label: string,
  fn: () => Promise<S.Result> | S.Result,
) {
  const only = str('only', '')
  if (only && !only.split(',').includes(scenario)) return
  log(`=== ${w.suite}: ${scenario}${label ? ` ${label}` : ''}`)
  const t0 = performance.now()
  const data = await fn()
  save(w, scenario, label, data, Math.round((performance.now() - t0) / 100) / 10)
}

/** The scenarios every sized suite runs, in order, on one collection. */
async function sized(
  w: World,
  o: { days: [number, number, number]; forkDays: number; samples: number },
) {
  const profiles = w.latency === 'none' ? ['none'] : ['r2', 'r2-slow']
  const reads = (label: string, exportIt = false) =>
    step(w, 'reads', label, () => S.reads(w, label, { profiles, exportIt, samples: o.samples }))
  await step(w, 'load', '', () => S.load(w))
  await reads('0-since-rebuild', true)
  // Commits pile up with no rebuild, to see how reads degrade.
  await step(w, 'daily', `first-${o.days[0]}`, () => S.daily(w, o.days[0], false))
  await reads(`${o.days[0]}-since-rebuild`)
  await step(w, 'daily', `next-${o.days[1]}`, () => S.daily(w, o.days[1], false))
  await reads(`${o.days[0] + o.days[1]}-since-rebuild`)
  // The rebuild policy catches up, then runs after every day.
  await step(w, 'maintain', 'catch-up', () => S.maintain(w))
  await reads('rebuilt', true)
  await step(w, 'daily', `maintained-${o.days[2]}`, () => S.daily(w, o.days[2], true))
  await reads('after-policy')
  await step(w, 'recreate', '', () => S.recreate(w, { write: 2 }))
  await step(w, 'schema', '', () => S.schemaChange(w))
  await step(w, 'forks', '', () => S.forks(w, o.forkDays))
  // Two days at the rate layout F's bench used (240,000 a day at Crossref's size), to set beside its.
  await step(w, 'daily', 'f-rate-2', () => S.daily(w, 2, true, 240_000 / 180_000_000))
  // The same 1,000-change upload at every size: what a commit costs apart from its own upload.
  await step(w, 'daily', 'fixed-1000', () => S.daily(w, 3, true, 1000 / w.records))
  await step(w, 'storage', '', () => S.storageSplit(w))
}

const MANY_DEFAULT = { records: 9, days: 2, streams: 8 }

async function suite(name: string): Promise<void> {
  const latency = str('latency', name === 'gate' ? 'none' : 'r2')
  const workers = num('workers', Math.max(2, Math.min(10, cpus().length - 2)))
  const base = { latency, workers, ...(args.level ? { level: num('level', 6) } : {}) }
  // A suite's folder is its name, or `--label` (a trial of a suite beside the real run).
  const folder = suiteOf(name)
  if (!args.keep && !args.resume && name !== 'crossref-extra' && name !== 'split') {
    await rm(join(benchDir(), 'v3', folder), { recursive: true, force: true })
  }
  switch (name) {
    case 'gate': {
      const w = world(folder, { ...base, records: 20_000 })
      await sized(w, { days: [3, 7, 12], forkDays: 5, samples: 40 })
      const o = { ...MANY_DEFAULT, collections: 60, burst: 20 }
      await step(w, 'many', '', () => S.many(w, o))
      await step(w, 'sweep', '', () => S.sweepUnderLoad(w, o))
      await step(w, 'racing', '', () => S.racing(w, { writers: 3, streams: 4, commits: 3 }))
      await step(w, 'policy', '', () => S.policySim())
      await step(w, 'policy-year', '', () =>
        S.policyYear(w, { records: 3000, days: 40, ratios: [10, 4] }),
      )
      await step(w, 'fork-edit', '', () => S.forkEdit(w, [0.25, 1], { tier: 6, keep: 3 }))
      // The same rows in one part and in three: the same files.
      await step(w, 'routes', '', () => S.routes(w, [1, 3]))
      break
    }
    case 'quick':
      await sized(world(folder, { ...base, records: 100_000 }), {
        days: [10, 20, 30],
        forkDays: 30,
        samples: 100,
      })
      break
    case '1m':
      await sized(world(folder, { ...base, records: 1_000_000 }), {
        days: [10, 20, 30],
        forkDays: 30,
        samples: 200,
      })
      break
    case '5m':
      await sized(world(folder, { ...base, records: 5_000_000 }), {
        days: [10, 20, 30],
        forkDays: 30,
        samples: 200,
      })
      break
    case '12m':
      await sized(world(folder, { ...base, records: 12_000_000 }), {
        days: [10, 20, 30],
        forkDays: 30,
        samples: 200,
      })
      break
    case 'many': {
      const o = {
        ...MANY_DEFAULT,
        collections: num('collections', 20_000),
        burst: num('burst', 2_000),
        records: num('records', MANY_DEFAULT.records),
        streams: num('streams', MANY_DEFAULT.streams),
      }
      const w = world(folder, { ...base, records: o.records })
      await step(w, 'many', '', () => S.many(w, o))
      await step(w, 'sweep', '', () => S.sweepUnderLoad(w, o))
      break
    }
    case 'racing': {
      const w = world(folder, { ...base, records: 0 })
      // Eight writers to one collection, then sixty-four: one winner for each number either
      // way, and what the losers cost.
      await step(w, 'racing', 'eight', () =>
        S.racing(w, { writers: num('writers', 8), streams: 1, commits: num('commits', 10) }),
      )
      await step(w, 'racing', 'sixty-four', () =>
        S.racing(w, {
          writers: num('writers', 8),
          streams: num('streams', 8),
          commits: num('commits', 10),
        }),
      )
      break
    }
    case 'policy': {
      // The policy by arithmetic at Crossref's size, and for real over a year at reduced scale.
      const records = num('records', 50_000)
      const w = world(folder, { ...base, records })
      await step(w, 'policy', '', () => S.policySim())
      await step(w, 'policy-year', '', () =>
        S.policyYear(w, { records, days: num('days', 365), ratios: [10, 4, 2] }),
      )
      break
    }
    case 'crossref': {
      // All of Crossref from the sorted dump, then 30 daily commits. `--files n` reads only the
      // first n dump files (a trial).
      const w = world(folder, {
        ...base,
        records: num('records', 179_518_552),
      })
      const o = {
        dataDir: str('data', '/data/crossref-sort/sorted'),
        plan: str('plan', '/data/crossref-sort/plan.json'),
        ...(args.files ? { files: num('files', 0) } : {}),
      }
      const days = num('days', 30)
      const first = Math.round(days / 3)
      const profiles = ['r2', 'r2-slow']
      const reads = (label: string, exportIt = false) =>
        step(w, 'reads', label, async () =>
          S.reads(w, label, { profiles, exportIt, keys: await S.crossrefKeys(w, 200) }),
        )
      await step(w, 'load', '', () => S.crossrefLoad(w, o))
      await reads('0-since-rebuild')
      await step(w, 'daily', `first-${first}`, () => S.crossrefDaily(w, o, first, false))
      await reads(`${first}-since-rebuild`)
      await step(w, 'daily', `next-${days - first}`, () =>
        S.crossrefDaily(w, o, days - first, false),
      )
      await reads(`${days}-since-rebuild`)
      await step(w, 'maintain', 'catch-up', () => S.maintain(w))
      await reads('rebuilt', true)
      // Then days with the rebuild policy on, as the sized suites have.
      const kept = Math.max(2, Math.round(days / 6))
      await step(w, 'daily', `maintained-${kept}`, () => S.crossrefDaily(w, o, kept, true))
      await reads('after-policy')
      await step(w, 'recreate', '', () => S.recreate(w, { write: 2 }))
      await step(w, 'schema', '', () => S.crossrefSchema(w, str('schema-type', 'dataset')))
      await step(w, 'forks', '', () => S.crossrefForks(w, o, num('fork-days', 10)))
      await step(w, 'storage', '', () => S.storageSplit(w))
      break
    }
    case 'api-crossref': {
      // The Crossref sample through a deployed server's API (v3-deploy-plan.md, Phase 2's exit):
      // built here as the crossref suite builds it, sent as a client sends it. The key is UL_KEY.
      const w = world(folder, { ...base, records: num('records', 179_518_552) })
      const o = {
        dataDir: str('data', '/data/crossref-sort/sorted'),
        plan: str('plan', '/data/crossref-sort/plan.json'),
        files: num('files', 2000),
      }
      const t = {
        base: str('to', ''),
        collection: str('collection', ''),
        key: process.env.UL_KEY ?? '',
        parallel: num('parallel', 8),
      }
      if (!t.base || !t.collection || !t.key)
        throw new Error('api-crossref needs --to, --collection, and UL_KEY')
      let keys: [string, string][] = []
      await step(w, 'api-load', '', async () => {
        const r = await API.apiCrossrefLoad(w, o, t)
        keys = r.keys as [string, string][]
        return r
      })
      await step(w, 'api-reads', 'after-load', () => API.apiReads(t, keys, 'after-load'))
      const days = num('days', 6)
      await step(w, 'api-daily', `${days}`, () => API.apiCrossrefDays(w, o, t, days))
      await step(w, 'api-reads', 'after-days', () => API.apiReads(t, keys, 'after-days'))
      break
    }
    case 'fork-edit': {
      // Fork, edit one record, rebuild keeping untouched files: what is stored, by file size.
      const records = num('records', 1_000_000)
      const w = world(folder, { ...base, records })
      const targets = str('targets', '8,32,128').split(',').map(Number)
      // Then how sharing fades over days, under the tier rule and under a full merge each
      // day that keeps untouched files (`--keep-days 0` leaves that out: it rewrites a lot).
      const days = { tier: num('tier-days', 30), keep: num('keep-days', 4) }
      await step(w, 'fork-edit', '', () => S.forkEdit(w, targets, days))
      // The 1,000-change upload every sized suite commits, on the first target's parent.
      const parent: World = {
        ...w,
        collection: `cut${String(targets[0]).replace('.', '_')}`,
      }
      await step(w, 'daily', 'fixed-1000', () => S.daily(parent, 3, true, 1000 / records))
      break
    }
    case 'split': {
      // What a store an earlier chain left is made of (`--label` names its folder; nothing is
      // emptied or written but the result).
      const w = world(folder, { ...base, records: 0 })
      await step(w, 'storage', '', () => S.storageSplit(w))
      break
    }
    case 'crossref-extra': {
      // More steps on a Crossref store an earlier chain left (`--label` names its folder; it is
      // never emptied here): days with the rebuild policy on, then reads.
      const w = world(str('label', 'crossref'), {
        ...base,
        records: num('records', 179_518_552),
      })
      const o = {
        dataDir: str('data', '/data/crossref-sort/sorted'),
        plan: str('plan', '/data/crossref-sort/plan.json'),
        ...(args.files ? { files: num('files', 0) } : {}),
      }
      if (args.rest) {
        // The dump's files from `--rest` on, as one upload onto the collection: what a load
        // that stopped short left out, and a large commit onto a large collection.
        const rest = { ...o, from: num('rest', 0), files: num('rest-files', 0) }
        await step(w, 'load', 'rest', () =>
          S.crossrefLoad(w, rest, { append: true, message: 'The rest of the dump' }),
        )
        await step(w, 'maintain', 'rest', () => S.maintain(w))
        await step(w, 'reads', 'with-rest', async () =>
          S.reads(w, 'with-rest', {
            profiles: ['r2', 'r2-slow'],
            keys: await S.crossrefKeys(w, 200),
          }),
        )
        break
      }
      const days = num('days', 5)
      await step(w, 'daily', `maintained-${days}`, () => S.crossrefDaily(w, o, days, true))
      await step(w, 'reads', 'after-policy', async () =>
        S.reads(w, 'after-policy', {
          profiles: ['r2', 'r2-slow'],
          keys: await S.crossrefKeys(w, 200),
        }),
      )
      break
    }
    default:
      throw new Error(`Unknown suite "${name}"`)
  }
  const problems = check(join(benchDir(), 'v3', 'results'), folder)
  for (const p of problems) log(`CHECK FAILED: ${p}`)
  log(problems.length > 0 ? `=== ${name}: FAILED checks` : `=== ${name}: all done`)
  if (problems.length > 0) process.exitCode = 1
}

const suiteOf = (name: string) =>
  str('label', name === 'many' ? `many-${num('collections', 20_000)}` : name)

/** What must hold in a suite's results, whatever its size: the design's correctness claims. */
function check(resultsDir: string, suiteName: string): string[] {
  const out: string[] = []
  type R = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const r of readResults(resultsDir) as R[]) {
    if (r.suite !== suiteName) continue
    const what = `${r.scenario}${r.label ? ` ${r.label}` : ''}`
    if (r.scenario === 'recreate' && r.differ > 0)
      out.push(`${what}: ${r.differ} commits recreate to other ids`)
    if (r.scenario === 'recreate' && r.sweep?.missing?.length > 0)
      out.push(`${what}: the sweep found listed files missing`)
    if (
      r.scenario === 'racing' &&
      (!r.oneWinnerPerNumber || r.lostUploads > 0 || r.commits !== r.expected)
    ) {
      out.push(`${what}: commits ${r.commits}/${r.expected}, lost uploads ${r.lostUploads}`)
    }
    if (r.scenario === 'routes' && !r.sameFiles) {
      out.push(`${what}: the same rows built in other parts gave other files`)
    }
    if (r.scenario === 'sweep' && (r.broken > 0 || r.missing > 0 || r.commitFailures > 0)) {
      out.push(`${what}: ${r.broken} collections broken, ${r.missing} listed files missing`)
    }
    if (r.scenario === 'many') {
      if (r.load?.failed > 0) out.push(`${what}: ${r.load.failed} loads failed`)
      if (r.burst?.failed > 0) out.push(`${what}: ${r.burst.failed} burst commits failed`)
      for (const d of r.days ?? [])
        if (d.failed > 0) out.push(`${what}: day ${d.day}, ${d.failed} commits failed`)
      for (const p of r.sweep ?? [])
        if (p.missing > 0) out.push(`${what}: sweep pass ${p.pass} found ${p.missing} missing`)
    }
    if (r.scenario === 'forks') {
      if (r.fork?.recordBytesAdded !== 0)
        out.push(`${what}: a fork added ${r.fork?.recordBytesAdded} record bytes`)
      for (const t of r.track ?? [])
        if (t.missing > 0) out.push(`${what}: day ${t.day}, ${t.missing} listed files missing`)
    }
    // The heap cap is 128 MB in every process; a process over it would have died, failing the step.
  }
  return out
}

async function main(): Promise<void> {
  const [command, what] = args._
  if (command === 'worker') return runJob(what!)
  if (command === 'suite') return suite(what ?? 'gate')
  if (command === 'run') return suite(what ?? 'gate')
  if (command === 'report') {
    const out = str(
      'out',
      process.env.UL_REPORT_OUT ?? join(benchDir(), 'v3', 'results', 'report.html'),
    )
    writeReport(join(benchDir(), 'v3', 'results'), out)
    console.log(out)
    return
  }
  if (command === 'status') {
    const dir = join(benchDir(), 'v3')
    console.log(
      existsSync(dir) ? execFileSync('du', ['-sh', dir]).toString().trim() : `${dir}: nothing`,
    )
    return
  }
  console.log(
    'bench.ts suite <gate|quick|1m|5m|12m|many|racing|policy|crossref> [--latency none|r2|r2-slow] ' +
      '[--workers n] [--only scenario,…] [--keep]\nbench.ts report [--out file]\nbench.ts status',
  )
  // Keep the library's entry in the bundle's reach for hands-on checks.
  void v3
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err)
    process.exit(1)
  },
)
