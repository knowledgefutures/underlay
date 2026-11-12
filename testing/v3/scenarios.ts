/**
 * The scenarios of the v3 scale bench (planning: v3-build-plan.md, "Bench").
 * Each returns a result object; `bench.ts` saves it and the report reads it.
 *
 * Every scenario measures wall time, CPU, the most memory any one process
 * held, requests by R2 class, and bytes. Reads also give requests and bytes per
 * read, cold and warm.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { listAll, v3 } from '../../packages/protocol/src/index.js'
import { hash32, idOf, prng, record, schemas, typeOf } from '../src/gen.js'
import { V3Engine } from './engine.js'
import {
  GB,
  log,
  MB,
  measure,
  type Measured,
  round,
  runWorker,
  signers,
  summary,
  type WorkerReport,
} from './lib.js'
import { BenchStore, type Counts, diskUsage, subCounts } from './store.js'
import {
  type BuildDumpSpec,
  type BuildGenReport,
  type BuildGenSpec,
  crossrefSchema as crossrefSchema0,
  type ExportSpec,
  gzLines,
  type ManySpec,
  manyId,
  type RaceSpec,
  type VerifySpec,
} from './workers.js'
import {
  CROSSREF_DAILY,
  CROSSREF_LINE_BYTES,
  CROSSREF_RECORDS,
  dayRows,
  engineOf,
  loadWorkload,
  pickKey,
  saveWorkload,
  schemaRows,
  state,
  storeOf,
  type World,
} from './world.js'

type KeyPair = [string, string]
export type Result = Record<string, unknown>

const reqs = (c: Counts) => c.classA + c.classB
const brief = (m: Measured) => ({
  seconds: m.seconds,
  cpuSeconds: m.cpuSeconds,
  peakRssMb: m.peakRssMb,
  peakHeapMb: m.peakHeapMb,
  classA: m.requests.classA,
  classB: m.requests.classB,
  bytesIn: m.requests.bytesIn,
  bytesOut: m.requests.bytesOut,
  cost: round(m.cost, 6),
  rateLimited: m.requests.rateLimited,
  createsLost: m.requests.createsLost,
})

/** Split a list of weighted items into `n` groups of about equal weight, keeping order. */
function split<T>(items: T[], n: number, weight: (t: T) => number): T[][] {
  const total = items.reduce((s, t) => s + weight(t), 0)
  const out: T[][] = []
  let cur: T[] = []
  let acc = 0
  for (const t of items) {
    cur.push(t)
    acc += weight(t)
    if (acc >= (total * (out.length + 1)) / n && out.length < n - 1) {
      out.push(cur)
      cur = []
    }
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/**
 * Commit an upload whose files the server has already verified in parallel:
 * the kind of change, the files installed from their session, then the signed
 * commit.
 */
async function commitVerified(
  store: BenchStore,
  collection: string,
  files: v3.FileRef[],
  session: string,
  message: string,
) {
  const { author, server } = await signers()
  const locate = (id: string) => v3.uploadKey(session, id)
  const view = await v3.openView(store, collection)
  const check = await v3.checkUpload(store, view, files, {
    verify: false,
    validate: false,
    checkAssets: false,
    locate,
  })
  // A first load names hundreds of files: install them a few at a time, as `commitUpload` does.
  await v3.inParallel(
    files.map((f) => async () => {
      await v3.installUpload(store, session, f.id)
      await store.delete(locate(f.id))
    }),
    16,
  )
  const head = await v3.findHead(store, collection, null)
  const change = await v3.makeChange(collection, { files, base: head?.id ?? null, message }, author)
  return v3.createCommit(store, collection, { change, bump: check.bump }, { signer: server })
}

// --- Load ---

/**
 * Build the generator's rows as an upload, in parallel: parts by key range, each moved in
 * to end on cut keys, then the seams between them. The files are the ones a single pass
 * over all the rows would write, whatever the number of parts.
 */
async function buildGenerated(
  w: World,
  session: string,
  parts: number,
  name = 'build',
): Promise<{ files: v3.FileRef[]; records: number; lineBytes: number; storedBytes: number }> {
  // Split points between parts, from a sample of keys.
  const sample: KeyPair[] = []
  const r = prng(hash32(`split/${w.seed}`))
  for (let k = 0; k < Math.min(20_000, w.records); k++) {
    const i = Math.floor(r() * w.records)
    sample.push([typeOf(w.seed, i), idOf(w.seed, i)])
  }
  sample.sort((a, b) => v3.compareKeys(a[0], a[1], b[0], b[1]))
  const cuts: (KeyPair | null)[] = [null]
  for (let p = 1; p < parts; p++) cuts.push(sample[Math.floor((sample.length * p) / parts)]!)
  cuts.push(null)
  const worker = (
    spec: Pick<BuildGenSpec, 'mode' | 'lo' | 'hi' | 'first' | 'last' | 'schemas'>,
    n: string,
  ) =>
    runWorker<WorkerReport & BuildGenReport>('build-gen', {
      session,
      storeDir: w.storeDir,
      scratchDir: join(w.dir, 'scratch', `${name}-${n}`),
      latency: w.latency,
      seed: w.seed,
      records: w.records,
      cutBytes: w.cutBytes,
      ...spec,
      ...(w.level === undefined ? {} : { level: w.level }),
    } satisfies BuildGenSpec)
  const built = await Promise.all(
    Array.from({ length: parts }, (_, p) =>
      worker(
        {
          mode: 'part',
          lo: cuts[p]!,
          hi: cuts[p + 1]!,
          first: p === 0,
          last: p === parts - 1,
          schemas: p === 0,
        },
        String(p),
      ),
    ),
  )
  // What two neighbours left between them: after one's last cut key, through the other's first.
  const seams = await Promise.all(
    built.slice(0, -1).map((b, p) =>
      worker(
        {
          mode: 'seam',
          lo: b.lastCut,
          hi: built[p + 1]!.firstCut,
          first: false,
          last: false,
          schemas: false,
        },
        `seam-${p}`,
      ),
    ),
  )
  const all = [...built, ...seams]
  const files = all
    .flatMap((b) => b.files)
    .sort((a, b) => v3.compareKeys(a.first![0], a.first![1], b.first![0], b.first![1]))
  const records = all.reduce((n, b) => n + b.records, 0)
  if (records !== w.records) {
    throw new Error(`build: ${records} records in the parts and seams, of ${w.records}`)
  }
  return {
    files,
    records,
    lineBytes: all.reduce((n, b) => n + b.lineBytes, 0),
    storedBytes: all.reduce((n, b) => n + b.storedBytes, 0),
  }
}

/**
 * The same rows built in one part and in several: do they give the same files? They should,
 * since a file ends only where the rows say, and parts end on cut keys.
 */
export async function routes(w: World, partCounts: number[]): Promise<Result> {
  const store = storeOf(w)
  const out: { parts: number; files: number; ids: string }[] = []
  for (const n of partCounts) {
    const session = v3.newSession()
    const b = await buildGenerated(w, session, n, `routes-${n}`)
    out.push({ parts: n, files: b.files.length, ids: b.files.map((f) => f.id).join(',') })
    // These uploads are never committed: take them out of the store again.
    for (const f of b.files) await store.inner.delete(v3.uploadKey(session, f.id))
  }
  const sameFiles = out.every((o) => o.ids === out[0]!.ids)
  log('routes', { parts: partCounts, files: out.map((o) => o.files), sameFiles })
  return {
    records: w.records,
    cutBytes: w.cutBytes,
    routes: out.map(({ parts, files }) => ({ parts, files })),
    sameFiles,
  }
}

/**
 * The first load from the generator: built in parallel parts by key range (the
 * client), verified in parallel (the server), committed once, and read at once.
 */
export async function load(w: World): Promise<Result> {
  const store = storeOf(w)
  await v3.createCollection(store, w.collection).catch(() => {})
  const parts = Math.max(1, Math.min(w.workers, Math.ceil(w.records / 20_000)))
  const session = v3.newSession()
  log(`load: building ${w.records} records in ${parts} parts`)
  const build = await measure(store, () => buildGenerated(w, session, parts))
  const { files, lineBytes, storedBytes } = build.value
  log(
    `load: built ${files.length} files, ${round(lineBytes / GB)} GB of lines, ${round(storedBytes / GB)} GB stored`,
  )

  const verify = await measure(store, async () => {
    const groups = split(files, parts, (f) => f.bytes)
    const reports = await Promise.all(
      groups.map((g) =>
        runWorker<WorkerReport & { records: number; problems: string[] }>('verify', {
          session,
          storeDir: w.storeDir,
          latency: w.latency,
          files: g,
          schemas: schemas(),
        } satisfies VerifySpec),
      ),
    )
    const problems = reports.flatMap((x) => x.problems)
    if (problems.length > 0)
      throw new Error(`load: verification refused the upload: ${problems[0]}`)
    return reports.reduce((n, x) => n + x.records, 0)
  })
  log(`load: verified ${verify.value} records`)

  const commit = await measure(store, () =>
    commitVerified(store, w.collection, files, session, 'first load'),
  )
  // Readable at commit: a record, straight away, with nothing cached.
  const wl = loadWorkload(w)
  saveWorkload(w, wl)
  const key = pickKey(wl, prng(1))
  const engine = engineOf(w)
  const first = await measure(store, async () => {
    const h = await engine.open(w.collection)
    return engine.readPoint(h, key.type, key.id)
  })
  if (first.value === 0) throw new Error('load: the first read after commit found nothing')
  return {
    records: w.records,
    files: files.length,
    lineBytes,
    storedBytes,
    storedOverLines: round(storedBytes / lineBytes, 4),
    build: {
      ...brief(build.m),
      recordsPerSecond: Math.round(w.records / build.m.seconds),
      mbPerCpuSecond: round(lineBytes / MB / build.m.cpuSeconds),
    },
    verify: {
      ...brief(verify.m),
      mbPerCpuSecond: round(lineBytes / MB / verify.m.cpuSeconds),
    },
    commit: {
      ...brief(commit.m),
      number: commit.value.commit.number,
      semver: commit.value.commit.semver,
    },
    firstRead: { ...brief(first.m), requests: reqs(first.m.requests) },
    stored: await diskUsage(w.storeDir),
  }
}

// --- Daily ---

/**
 * Days of Crossref-shaped changes, one commit a day. The client's build and
 * the server's commit are measured apart. With `maintain`, the rebuild policy
 * runs after each day and what it rewrites is measured too.
 */
export async function daily(
  w: World,
  days: number,
  maintain: boolean,
  rate = w.rate,
): Promise<Result> {
  const store = storeOf(w)
  const engine = engineOf(w)
  const wl = loadWorkload(w)
  const at = state(w, 'day', { day: 0 })
  const rows: Result[] = []
  for (let n = 0; n < days; n++) {
    const day = ++at.value.day
    // The day's rows are streamed into the build, never held: at 12M a day is over 100 MB.
    const build = await measure(store, () => engine.build(dayRows(wl, day, rate)))
    const commit = await measure(store, () =>
      engine.commitFiles(w.collection, build.value, `day ${day}`),
    )
    const row: Result = {
      day,
      commit: commit.value.number,
      changes: commit.value.entries,
      lineBytes: commit.value.lineBytes,
      storedBytes: commit.value.storedBytes,
      build: brief(build.m),
      server: brief(commit.m),
    }
    if (maintain) {
      const m = await measure(store, () => engine.maintain(w.collection))
      row.maintain = { ...brief(m.m), ...m.value }
      const h = await engine.open(w.collection)
      row.files = h.files
      row.groups = h.groups
    }
    rows.push(row)
    saveWorkload(w, wl)
    at.save()
    if (day % 5 === 0 || n === days - 1) {
      log(`daily: day ${day}`, {
        changes: commit.value.entries,
        server: (row.server as { seconds: number }).seconds,
      })
    }
  }
  const of = (pick: (r: Result) => number) => summary(rows.map(pick))
  const server = (r: Result) => r.server as ReturnType<typeof brief>
  const written = rows.reduce((n, r) => n + ((r.maintain as { written?: number })?.written ?? 0), 0)
  return {
    days,
    maintain,
    rate,
    records: wl.live,
    changesPerDay: of((r) => r.changes as number),
    storedBytesPerDay: of((r) => r.storedBytes as number),
    lineBytesPerDay: of((r) => r.lineBytes as number),
    serverSeconds: of((r) => server(r).seconds),
    serverCpuSeconds: of((r) => server(r).cpuSeconds),
    serverRequests: of((r) => server(r).classA + server(r).classB),
    serverClassA: of((r) => server(r).classA),
    serverPeakRssMb: Math.max(...rows.map((r) => server(r).peakRssMb)),
    serverPeakHeapMb: Math.max(...rows.map((r) => server(r).peakHeapMb)),
    buildSeconds: of((r) => (r.build as ReturnType<typeof brief>).seconds),
    ...(maintain
      ? {
          rewrittenBytesPerDay: Math.round(written / days),
          rewrittenBytesTotal: written,
          maintainPeakRssMb: Math.max(
            ...rows.map((r) => (r.maintain as { peakRssMb: number }).peakRssMb),
          ),
          maintainSeconds: of((r) => (r.maintain as { seconds: number }).seconds),
        }
      : {}),
    rows,
    stored: await diskUsage(w.storeDir),
  }
}

/** Run the rebuild policy until it has nothing to do, and say what it rewrote. */
export async function maintain(w: World): Promise<Result> {
  const store = storeOf(w)
  const engine = engineOf(w)
  const before = await engine.open(w.collection)
  const m = await measure(store, () => engine.maintain(w.collection))
  const after = await engine.open(w.collection)
  log('maintain', { ...m.value, files: after.files, groups: after.groups, seconds: m.m.seconds })
  return {
    ...brief(m.m),
    ...m.value,
    filesBefore: before.files,
    groupsBefore: before.groups,
    files: after.files,
    groups: after.groups,
    stored: await diskUsage(w.storeDir),
  }
}

// --- Reads ---

interface ReadStats {
  n: number
  requests: ReturnType<typeof summary>
  bytes: ReturnType<typeof summary>
  ms: ReturnType<typeof summary>
}

async function timed(
  store: BenchStore,
  n: number,
  fn: (i: number) => Promise<unknown>,
): Promise<ReadStats> {
  const requests: number[] = []
  const bytes: number[] = []
  const ms: number[] = []
  for (let i = 0; i < n; i++) {
    const before = store.snapshot()
    const t0 = performance.now()
    await fn(i)
    ms.push(performance.now() - t0)
    const d = subCounts(store.snapshot(), before)
    requests.push(reqs(d))
    bytes.push(d.bytesOut)
  }
  return { n, requests: summary(requests), bytes: summary(bytes), ms: summary(ms) }
}

/**
 * Point reads, pages, a diff page, history, and an export, under each latency
 * profile. `label` says how many commits have landed since the last rebuild.
 */
export async function reads(
  w: World,
  label: string,
  opts: {
    profiles?: string[]
    exportIt?: boolean
    samples?: number
    /** Keys to read; by default live records picked from the generator's state. */
    keys?: { type: string; id: string }[]
  } = {},
): Promise<Result> {
  const pick = prng(hash32(`reads/${label}`))
  let keys = opts.keys
  const out: Result = { label }
  if (!keys) {
    const wl = loadWorkload(w)
    keys = Array.from({ length: opts.samples ?? 200 }, () => pickKey(wl, pick))
    out.records = wl.live
  }
  const n = keys.length
  for (const profile of opts.profiles ?? ['r2', 'r2-slow']) {
    const store = storeOf(w, profile)
    const engine = new V3Engine(store)
    const open = await measure(store, () => engine.open(w.collection))
    const h = open.value
    const p: Result = {
      files: h.files,
      groups: h.groups,
      version: h.version,
      open: { seconds: open.m.seconds, requests: reqs(open.m.requests) },
    }
    // Cold: nothing cached, the version resolved from the store first.
    p.pointCold = await timed(store, Math.min(20, n), async (i) => {
      engine.dropCaches()
      const fresh = await engine.open(w.collection)
      await engine.readPoint(fresh, keys[i]!.type, keys[i]!.id)
    })
    // Footers cached, version resolved: what a server that has seen the collection pays.
    engine.dropCaches()
    for (const k of keys) await engine.readPoint(h, k.type, k.id)
    p.pointWarm = await timed(store, n, (i) => engine.readPoint(h, keys[i]!.type, keys[i]!.id))
    p.page50 = await timed(store, Math.min(20, n), (i) =>
      engine.readPage(h, keys[i]!.type, keys[i]!.id, 50),
    )
    if (h.version > 1) {
      p.diffPage500 = await timed(store, 3, () =>
        engine.diff(h, h.version - 1, { before: false, limit: 500 }),
      )
      p.diffPage500Before = await timed(store, 3, () =>
        engine.diff(h, h.version - 1, { before: true, limit: 500 }),
      )
    }
    p.history = await timed(store, Math.min(20, n), (i) =>
      engine.history(h, keys[i]!.type, keys[i]!.id),
    )
    out[profile] = p
    log(`reads ${label} ${profile}`, {
      groups: h.groups,
      warm: (p.pointWarm as ReadStats).requests.p50,
      cold: (p.pointCold as ReadStats).requests.p50,
      warmMs: (p.pointWarm as ReadStats).ms.p50,
    })
  }
  if (opts.exportIt) out.export = await exportAll(w)
  return out
}

/** A full export of the newest version, split by key range across workers. */
export async function exportAll(w: World, version?: number): Promise<Result> {
  const store = storeOf(w)
  const view = await v3.openView(store, w.collection, version === undefined ? {} : { version })
  // Cut the key space where the largest files begin.
  const firsts = view.files
    .filter((f) => f.first)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 4096)
    .map((f) => f.first!)
    .sort((a, b) => v3.compareKeys(a[0], a[1], b[0], b[1]))
  const parts = Math.max(1, Math.min(w.workers, firsts.length))
  const cuts: (KeyPair | null)[] = [null]
  for (let p = 1; p < parts; p++) cuts.push(firsts[Math.floor((firsts.length * p) / parts)]!)
  cuts.push(null)
  const m = await measure(store, async () => {
    const reports = await Promise.all(
      Array.from({ length: parts }, (_, p) =>
        runWorker<WorkerReport & { records: number; bytes: number }>('export', {
          storeDir: w.storeDir,
          latency: w.latency,
          collection: w.collection,
          version: view.version,
          from: cuts[p]!,
          to: cuts[p + 1]!,
        } satisfies ExportSpec),
      ),
    )
    return {
      records: reports.reduce((n, r) => n + r.records, 0),
      bytes: reports.reduce((n, r) => n + r.bytes, 0),
    }
  })
  log('export', { ...m.value, seconds: m.m.seconds })
  return {
    ...brief(m.m),
    ...m.value,
    parts,
    version: view.version,
    mbPerSecond: round(m.value.bytes / MB / m.m.seconds),
    mbPerCpuSecond: round(m.value.bytes / MB / m.m.cpuSeconds),
  }
}

// --- Recreate ---

/**
 * Determinism at scale: with every commit's own files gone (swept), make each
 * commit's files again from the rebuilt ones and compare ids with the log.
 */
export async function recreate(w: World, opts: { write?: number } = {}): Promise<Result> {
  const store = storeOf(w)
  const cache = new v3.FileCache()
  // Sweep with no grace, so files the layout no longer lists are gone from the folder.
  const sweep = await measure(store, async () => {
    let t = Date.now()
    await v3.sweep(store, { graceMs: 0, trashMs: 0, now: () => t })
    const second = await v3.sweep(store, { graceMs: 0, trashMs: 0, now: () => (t += 1) })
    const third = await v3.sweep(store, { graceMs: 0, trashMs: 0, now: () => (t += 1) })
    return {
      trashed: second.records.trashed,
      purged: third.records.purged,
      missing: third.records.missing,
    }
  })
  const { files, layout } = await v3.currentFiles(store, w.collection)
  const head = await v3.headNumber(store, w.collection)
  let match = 0
  let differ = 0
  let gone = 0
  let written = 0
  const differing: number[] = []
  const m = await measure(store, async () => {
    for await (const s of v3.readLog(store, w.collection, 1, head)) {
      const wants = v3.commitFiles(s.commit)
      let absent = 0
      for (const f of wants) if (!(await store.inner.head(v3.recordKey(f.id)))) absent++
      if (absent > 0) gone++
      const write = absent > 0 && written < (opts.write ?? 0)
      const made = await v3.recreate(store, files, s.commit, {
        cache,
        ...(write ? { target: v3.storeTarget(store) } : {}),
      })
      if (write) written++
      if (made.length === wants.length && made.every((x) => x.matches)) match++
      else {
        differ++
        differing.push(s.commit.number)
      }
    }
  })
  log('recreate', { commits: head, match, differ, originalsGone: gone })
  if (differ > 0) log('recreate: IDS DIFFER', differing.slice(0, 20))
  return {
    ...brief(m.m),
    commits: head,
    match,
    differ,
    differing: differing.slice(0, 50),
    originalsGone: gone,
    rewritten: written,
    layout: layout?.number ?? 0,
    sweep: { ...brief(sweep.m), ...sweep.value },
  }
}

// --- Forks ---

/**
 * Fork the collection, edit 1% of the fork, then give both daily changes and
 * maintenance for some days. Tracks what each lists (logical) against what the
 * location stores (physical), so how fast sharing fades can be read off.
 */
export async function forks(w: World, days: number): Promise<Result> {
  const store = storeOf(w)
  const engine = engineOf(w)
  const fork = `${w.collection}-fork`
  const before = await diskUsage(w.storeDir)
  const forked = await measure(store, () => engine.fork(w.collection, fork))
  const after = await diskUsage(w.storeDir)
  const recordBytesAdded = (after.records?.bytes ?? 0) - (before.records?.bytes ?? 0)
  log('fork', { ...forked.value, seconds: forked.m.seconds, recordBytesAdded })

  const parent = loadWorkload(w)
  const child = parent.fork('fork')
  // Edit 1% of the fork in one commit.
  const edit = await measure(store, () => engine.commit(fork, dayRows(child, 100_000, 0.01)))
  const at = state(w, 'day', { day: 0 })
  let t = Date.now()
  /** Logical and physical bytes now, after a sweep that reclaims at once. */
  const account = async (day: number) => {
    // Two passes with no grace: condemn, then move out; a third deletes.
    for (let i = 0; i < 3; i++)
      await v3.sweep(store, { graceMs: 0, trashMs: 0, now: () => (t += 1) })
    const s = await v3.sweep(store, { graceMs: 0, trashMs: 0, now: () => (t += 1) })
    const p = s.logical.get(w.collection)?.bytes ?? 0
    const f = s.logical.get(fork)?.bytes ?? 0
    const physical = s.records.listedBytes
    return {
      day,
      parentBytes: p,
      forkBytes: f,
      physicalBytes: physical,
      // Of what the fork lists, the share stored once for both.
      sharedShare: f > 0 ? round((p + f - physical) / f, 4) : 0,
      missing: s.records.missing.length,
    }
  }
  const track = [await account(0)]
  let rewritten = 0
  for (let n = 1; n <= days; n++) {
    const day = ++at.value.day
    await engine.commit(w.collection, dayRows(parent, day, w.rate))
    await engine.commit(fork, dayRows(child, day, w.rate))
    rewritten += (await engine.maintain(w.collection)).written
    rewritten += (await engine.maintain(fork)).written
    if (n % 5 === 0 || n === days) {
      track.push(await account(n))
      log(`forks: day ${n}`, track[track.length - 1])
    }
  }
  saveWorkload(w, parent)
  saveWorkload(w, child, fork)
  at.save()
  return {
    fork: { ...brief(forked.m), ...forked.value, recordBytesAdded },
    edit: { ...brief(edit.m), entries: edit.value.entries, storedBytes: edit.value.storedBytes },
    days,
    rewrittenBytes: rewritten,
    track,
  }
}

// --- Schema ---

/** A schema change on the largest type: one that only relaxes, and one that makes the server scan. */
export async function schemaChange(w: World, type = 'journal-article'): Promise<Result> {
  const store = storeOf(w)
  const engine = engineOf(w)
  const base = (schemas() as Record<string, { required: string[] }>)[type]!
  const h = await engine.open(w.collection)
  const count = (await v3.counts(store, h.view as v3.View, { type })).get(type)
  const change = async (body: unknown) => {
    const upload = await engine.build([v3.rowFromRecord(type, v3.SCHEMA_TYPE, body)])
    const m = await measure(store, () => engine.commitFiles(w.collection, upload, 'schema'))
    return { ...brief(m.m), semver: m.value.semver, scanned: m.value.scanned }
  }
  // Dropping a required field can't reject a record: no scan.
  const relaxed = await change({ ...base, required: base.required.slice(0, -1) })
  // Requiring a field every record has: valid, but the server has to look.
  const stricter = await change({ ...base, required: [...base.required, 'URL'] })
  log('schema', { relaxed: relaxed.seconds, stricter: stricter.seconds, scanned: stricter.scanned })
  return {
    type,
    records: count?.records ?? 0,
    lineBytes: count?.bytes ?? 0,
    relaxed,
    stricter: {
      ...stricter,
      recordsPerSecond: Math.round(stricter.scanned / stricter.seconds),
      mbPerCpuSecond: round((count?.bytes ?? 0) / MB / stricter.cpuSeconds),
    },
  }
}

// --- Many collections ---

export interface ManyOptions {
  collections: number
  burst: number
  /** The median size of a collection's first load, in records (sizes are skewed: see manySize). */
  records: number
  /** Days of small commits to every collection after loading. */
  days: number
  streams: number
}

async function manyPhase(
  w: World,
  store: BenchStore,
  o: ManyOptions,
  phase: 'load' | 'day',
  day: number,
  from: number,
  to: number,
  streams: number,
) {
  const per = Math.ceil((to - from) / w.workers)
  const m = await measure(store, async () => {
    const reports = await Promise.all(
      Array.from({ length: w.workers }, (_, p) => {
        const a = from + p * per
        const b = Math.min(to, a + per)
        if (a >= b) return null
        return runWorker<
          WorkerReport & {
            commits: number
            failed: number
            commitMs: number[]
            commitRequests: number[]
            merges: number
            written: number
          }
        >('many', {
          storeDir: w.storeDir,
          scratchDir: join(w.dir, 'scratch', `many-${p}`),
          latency: w.latency,
          from: a,
          to: b,
          phase,
          day,
          records: o.records,
          // A few changes a day in a small collection.
          rate: 0.05,
          streams,
          tiers: { ratio: 10, baseBytes: 8 * MB },
          maintain: phase === 'day',
        } satisfies ManySpec)
      }),
    )
    const done = reports.filter((r) => r !== null)
    return {
      commits: done.reduce((n, r) => n + r.commits, 0),
      failed: done.reduce((n, r) => n + r.failed, 0),
      commitMs: summary(done.flatMap((r) => r.commitMs)),
      commitRequests: summary(done.flatMap((r) => r.commitRequests)),
      merges: done.reduce((n, r) => n + r.merges, 0),
      written: done.reduce((n, r) => n + r.written, 0),
    }
  })
  return {
    ...brief(m.m),
    ...m.value,
    commitsPerSecond: round(m.value.commits / m.m.seconds),
  }
}

/**
 * Many collections in one location: load them, give each some small commits,
 * have a burst of them commit at once, and sweep across all of them.
 */
export async function many(w: World, o: ManyOptions): Promise<Result> {
  const store = storeOf(w)
  const out: Result = { ...o }
  // Loading in thousands, so a slowdown as the location fills would show.
  const loadSteps: Result[] = []
  for (let from = 0; from < o.collections; from += 1000) {
    const to = Math.min(o.collections, from + 1000)
    const r = await manyPhase(w, store, o, 'load', 0, from, to, o.streams)
    loadSteps.push({
      from,
      to,
      seconds: r.seconds,
      commitMs: r.commitMs,
      failed: r.failed,
      peakRssMb: r.peakRssMb,
    })
    log(`many: loaded ${to}`, { seconds: r.seconds, p50ms: r.commitMs.p50, failed: r.failed })
  }
  out.load = {
    steps: loadSteps,
    seconds: round(loadSteps.reduce((n, s) => n + (s.seconds as number), 0)),
    failed: loadSteps.reduce((n, s) => n + (s.failed as number), 0),
    // The last thousand against the first: 1 means no slowdown as the location fills.
    lastOverFirst: round(
      (loadSteps[loadSteps.length - 1]!.seconds as number) / (loadSteps[0]!.seconds as number),
    ),
  }
  log('many: load done', out.load)
  const days: Result[] = []
  for (let day = 1; day <= o.days; day++) {
    const r = await manyPhase(w, store, o, 'day', day, 0, o.collections, o.streams)
    days.push({ day, ...r })
    log(`many: day ${day}`, {
      seconds: r.seconds,
      commitsPerSecond: r.commitsPerSecond,
      failed: r.failed,
    })
  }
  out.days = days
  // The burst: this many collections commit at once.
  const burst = await manyPhase(
    w,
    store,
    o,
    'day',
    o.days + 1,
    0,
    Math.min(o.burst, o.collections),
    Math.ceil(o.burst / w.workers),
  )
  out.burst = burst
  log('many: burst', {
    seconds: burst.seconds,
    commitsPerSecond: burst.commitsPerSecond,
    p95ms: burst.commitMs.p95,
    failed: burst.failed,
  })
  out.sweep = await sweepPasses(w, 2)
  out.stored = await diskUsage(w.storeDir)
  return out
}

/** Sweep passes over the whole location, each measured. */
export async function sweepPasses(
  w: World,
  passes: number,
  graceMs = 0,
  /** Other steps' workers are running: count only this process's own work. */
  own = false,
): Promise<Result[]> {
  const store = storeOf(w)
  const out: Result[] = []
  let t = Date.now()
  for (let i = 0; i < passes; i++) {
    const m = await measure(
      store,
      () => v3.sweep(store, { graceMs, trashMs: graceMs, now: () => t }),
      own,
    )
    t += 1
    const s = m.value
    out.push({
      ...brief(m.m),
      pass: s.pass,
      collections: s.collections,
      files: s.records.objects,
      listed: s.records.listed,
      condemned: s.records.condemned,
      trashed: s.records.trashed,
      trashedBytes: s.records.trashedBytes,
      purged: s.records.purged,
      purgedBytes: s.records.purgedBytes,
      missing: s.records.missing.length,
      msPerCollection: round((m.m.seconds * 1000) / Math.max(1, s.collections), 3),
      requestsPerCollection: round(reqs(m.m.requests) / Math.max(1, s.collections), 2),
    })
    log(`sweep pass ${s.pass}`, out[out.length - 1])
  }
  return out
}

/**
 * The sweep under load: delete a tenth of the collections and thin history on
 * others while commits keep landing, with passes of the sweep running through
 * it. Nothing a collection lists may go missing.
 */
export async function sweepUnderLoad(w: World, o: ManyOptions): Promise<Result> {
  const store = storeOf(w)
  const n = o.collections
  const doomed = Math.floor(n / 10)
  const before = await diskUsage(w.storeDir)
  const work = (async () => {
    // Deleting the first tenth, thinning the second, committing to the third.
    for (let i = 0; i < doomed; i++) await v3.deleteCollection(store, manyId(i))
    let thinned = 0
    for (let i = doomed; i < 2 * doomed; i++) {
      const head = await v3.headNumber(store, manyId(i))
      const r = await v3.rebuild(store, manyId(i), { plan: v3.planAll, retained: [[head, head]] })
      if (r.layout) thinned++
    }
    return thinned
  })()
  const commits = manyPhase(
    w,
    store,
    o,
    'day',
    o.days + 2,
    2 * doomed,
    Math.min(n, 3 * doomed),
    o.streams,
  )
  const during = await sweepPasses(w, 2, 0, true)
  const thinned = await work
  const committed = await commits
  const after = await sweepPasses(w, 3)
  // Every collection left has an unbroken log, every file it lists, and reads.
  let checked = 0
  let broken = 0
  for (let i = doomed; i < n; i += Math.max(1, Math.floor(n / 200))) {
    try {
      await v3.verifyLog(store, manyId(i))
      for (const f of (await v3.currentFiles(store, manyId(i))).files) {
        await v3.SortedFile.open(store.inner, v3.recordKey(f.id), { id: f.id })
      }
      const view = await v3.openView(store, manyId(i))
      const got = await v3.page(store, view, { limit: 5 })
      if (got.length === 0) throw new Error('no records')
      checked++
    } catch (err) {
      broken++
      log(`sweep: ${manyId(i)} is broken: ${(err as Error).message}`)
    }
  }
  const end = await diskUsage(w.storeDir)
  let left = 0
  for await (const _ of listAll(store.inner, 'trash/')) left++
  const result = {
    deleted: doomed,
    thinned,
    committed: committed.commits,
    commitFailures: committed.failed,
    during,
    after,
    checked,
    broken,
    missing: [...during, ...after].reduce((m, p) => m + (p.missing as number), 0),
    recordBytesBefore: before.records?.bytes ?? 0,
    recordBytesAfter: end.records?.bytes ?? 0,
    reclaimedBytes: (before.records?.bytes ?? 0) - (end.records?.bytes ?? 0),
    leftInTrash: left,
  }
  log('sweep under load', { ...result, during: undefined, after: undefined })
  return result
}

// --- Racing ---

/** Many writers committing to one collection at once: one winner per number, no upload lost. */
export async function racing(
  w: World,
  o: { writers: number; streams: number; commits: number },
): Promise<Result> {
  const store = storeOf(w)
  const collection = `race${o.writers * o.streams}`
  await v3.createCollection(store, collection).catch(() => {})
  const m = await measure(store, async () =>
    Promise.all(
      Array.from({ length: o.writers }, (_, writer) =>
        runWorker<
          WorkerReport & {
            made: { number: number; file: string }[]
            ms: number[]
            refused: number
            layouts: number
          }
        >('race', {
          storeDir: w.storeDir,
          latency: w.latency,
          collection,
          writer,
          streams: o.streams,
          commits: o.commits,
        } satisfies RaceSpec),
      ),
    ),
  )
  const made = m.value.flatMap((r) => r.made)
  const expected = o.writers * o.streams * o.commits
  const numbers = new Set(made.map((x) => x.number))
  // The log itself: unbroken, and every upload's file named by exactly one commit.
  const head = await v3.verifyLog(store, collection, { files: true })
  const named = new Map<string, number>()
  for await (const s of v3.readLog(store, collection, 1, head?.commit.number ?? 0)) {
    for (const f of v3.commitFiles(s.commit)) named.set(f.id, (named.get(f.id) ?? 0) + 1)
  }
  const lost = made.filter((x) => named.get(x.file) !== 1).length
  const result = {
    writers: o.writers * o.streams,
    commits: made.length,
    expected,
    head: head?.commit.number ?? 0,
    distinctNumbers: numbers.size,
    oneWinnerPerNumber: numbers.size === made.length && (head?.commit.number ?? 0) === made.length,
    lostUploads: lost,
    // Commits refused after 50 lost tries and sent again, and tries lost for each commit made.
    refused: m.value.reduce((n, r) => n + r.refused, 0),
    layouts: m.value.reduce((n, r) => n + r.layouts, 0),
    lossesPerCommit: round(m.m.requests.createsLost / Math.max(1, made.length)),
    requestsPerCommit: round(
      (m.m.requests.classA + m.m.requests.classB) / Math.max(1, made.length),
    ),
    commitsPerSecond: round(made.length / m.m.seconds),
    commitMs: summary(m.value.flatMap((r) => r.ms)),
    ...brief(m.m),
  }
  log('racing', result)
  return result
}

// --- The rebuild policy over a long time ---

/**
 * The policy at full Crossref size over years, by arithmetic: groups of files are sizes,
 * a merge's output is the sum of its inputs (replaced rows are kept). Gives the
 * groups a key may sit in (a point read fetches a key block from a file of each) and the
 * bytes rewritten a day, for a range of ratios.
 */
export function policySim(
  opts: { days?: number; dailyBytes?: number; baseBytes?: number; loadBytes?: number } = {},
): Result {
  const days = opts.days ?? 3 * 365
  const daily =
    opts.dailyBytes ?? Math.round((CROSSREF_DAILY / CROSSREF_RECORDS) * CROSSREF_LINE_BYTES)
  const base = opts.baseBytes ?? 8 * MB
  const loadBytes = opts.loadBytes ?? CROSSREF_LINE_BYTES
  const out: Result[] = []
  for (const ratio of [2, 3, 4, 6, 8, 10]) {
    let groups: v3.FileGroup[] = [{ group: 1, files: [], commits: [1, 1], bytes: loadBytes }]
    let rewritten = 0
    let largest = 0
    let sumGroups = 0
    let maxGroups = 0
    const perYear: number[] = []
    let yearBytes = 0
    for (let d = 1; d <= days; d++) {
      groups.push({ group: 0, files: [], commits: [d + 1, d + 1], bytes: daily })
      for (;;) {
        const picked = v3.planTiered(groups, { ratio, baseBytes: base })
        if (!picked) break
        const bytes = picked.reduce((n, r) => n + r.bytes, 0)
        rewritten += bytes
        yearBytes += bytes
        largest = Math.max(largest, bytes)
        const at = groups.indexOf(picked[0]!)
        groups.splice(at, picked.length, {
          group: 1,
          files: [],
          commits: [picked[0]!.commits[0], picked[picked.length - 1]!.commits[1]],
          bytes,
        })
      }
      sumGroups += groups.length
      maxGroups = Math.max(maxGroups, groups.length)
      if (d % 365 === 0) {
        perYear.push(Math.round(yearBytes / 365))
        yearBytes = 0
      }
    }
    out.push({
      ratio,
      meanGroups: round(sumGroups / days),
      maxGroups,
      rewrittenLineBytesPerDay: Math.round(rewritten / days),
      rewrittenLineBytesPerDayByYear: perYear,
      largestMergeLineBytes: largest,
      // A day's upload is rewritten this many times over its life, on average.
      rewritesPerByte: round(rewritten / (daily * days)),
    })
  }
  return { days, dailyLineBytes: daily, loadLineBytes: loadBytes, baseBytes: base, ratios: out }
}

/**
 * The policy for real, over a year of daily commits at reduced scale, once for
 * each ratio: bytes rewritten a day, the groups of files a key may sit in, and what a
 * point read costs at the end.
 */
export async function policyYear(
  w: World,
  o: { records: number; days: number; ratios: number[] },
): Promise<Result> {
  const out: Result[] = []
  for (const ratio of o.ratios) {
    const collection = `year-r${ratio}`
    const yw: World = { ...w, collection, records: o.records, tiers: { ...w.tiers, ratio } }
    const store = storeOf(yw)
    const engine = engineOf(yw)
    const wl = loadWorkload(yw, collection)
    await v3.createCollection(store, collection).catch(() => {})
    await engine.commit(
      collection,
      (function* () {
        yield* schemaRows()
        for (const r of wl.initial()) yield v3.rowFromRecord(r.id, r.type, r.data)
      })(),
    )
    let written = 0
    let lines = 0
    let sumGroups = 0
    let maxGroups = 0
    const m = await measure(store, async () => {
      for (let day = 1; day <= o.days; day++) {
        const c = await engine.commit(collection, dayRows(wl, day, yw.rate))
        lines += c.lineBytes
        written += (await engine.maintain(collection)).written
        const { files } = await v3.currentFiles(store, collection)
        const groups = v3.groupsOf(files).length
        sumGroups += groups
        maxGroups = Math.max(maxGroups, groups)
      }
    })
    const h = await engine.open(collection)
    const pick = prng(hash32(`year/${ratio}`))
    const keys = Array.from({ length: 100 }, () => pickKey(wl, pick))
    engine.dropCaches()
    for (const k of keys) await engine.readPoint(h, k.type, k.id)
    const warm = await timed(store, keys.length, (i) =>
      engine.readPoint(h, keys[i]!.type, keys[i]!.id),
    )
    const stored = await diskUsage(yw.storeDir)
    out.push({
      ratio,
      days: o.days,
      seconds: m.m.seconds,
      groupsAtEnd: h.groups,
      meanGroups: round(sumGroups / o.days),
      maxGroups,
      dailyLineBytes: Math.round(lines / o.days),
      rewrittenStoredBytesPerDay: Math.round(written / o.days),
      // Stored bytes the policy wrote for each stored byte a day's upload brought.
      rewritesPerByte: round(written / (lines * 0.27)),
      warmRequests: warm.requests,
      peakRssMb: m.m.peakRssMb,
      recordBytes: stored.records?.bytes ?? 0,
    })
    log(`policy year, ratio ${ratio}`, out[out.length - 1])
  }
  return { records: o.records, ratios: out }
}

// --- Crossref ---

export interface CrossrefOptions {
  dataDir: string
  plan: string
  /** Read only this many of the dump's files (a trial). */
  files?: number
  /** Start at this file of the dump (the rest of a load that stopped short). */
  from?: number
}

/**
 * The sorted dump's files in key order: `<n>.jsonl.gz`, n from 0. The plan file's own `files`
 * lists the source dump's files, which are fewer (35,908 against 36,626): round 4's load took
 * its list from there and so left out the last 718.
 */
function dumpFiles(o: CrossrefOptions): { all: string[]; files: string[] } {
  const all = readdirSync(o.dataDir)
    .filter((f) => /^\d+\.jsonl\.gz$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
  const from = o.from ?? 0
  return { all, files: all.slice(from, o.files ? from + o.files : undefined) }
}

/** The full Crossref load from the sorted dump: single-pass parts in parallel, verified, committed. */
export async function crossrefLoad(
  w: World,
  o: CrossrefOptions,
  /** `append`: an upload onto a collection that is already there (the rest of the dump). */
  opts: { append?: boolean; message?: string } = {},
): Promise<Result> {
  const store = storeOf(w)
  const plan = JSON.parse(readFileSync(o.plan, 'utf8')) as { types: string[] }
  const { files } = dumpFiles(o)
  if (!opts.append) await v3.createCollection(store, w.collection).catch(() => {})
  const parts = Math.min(w.workers, files.length)
  const per = Math.ceil(files.length / parts)
  const session = v3.newSession()
  log(`crossref: building from ${files.length} dump files in ${parts} parts`)
  const build = await measure(store, () =>
    Promise.all(
      Array.from({ length: parts }, (_, p) =>
        runWorker<
          WorkerReport & {
            records: number
            duplicates: number
            files: v3.FileRef[]
            lineBytes: number
            storedBytes: number
          }
        >('build-dump', {
          session,
          storeDir: w.storeDir,
          latency: w.latency,
          dataDir: o.dataDir,
          files,
          start: p * per,
          end: Math.min(files.length, (p + 1) * per),
          first: p === 0,
          schemaTypes: p === 0 && !opts.append ? plan.types : null,
          cutBytes: w.cutBytes,
          ...(w.maxBytes === undefined ? {} : { maxBytes: w.maxBytes }),
          ...(w.level === undefined ? {} : { level: w.level }),
        } satisfies BuildDumpSpec),
      ),
    ),
  )
  const refs = build.value.flatMap((b) => b.files)
  const records = build.value.reduce((n, b) => n + b.records, 0)
  const lineBytes = build.value.reduce((n, b) => n + b.lineBytes, 0)
  const storedBytes = build.value.reduce((n, b) => n + b.storedBytes, 0)
  log(`crossref: built ${refs.length} files`, {
    records,
    lineGb: round(lineBytes / GB),
    storedGb: round(storedBytes / GB),
    seconds: build.m.seconds,
  })

  const verify = await measure(store, async () => {
    const reports = await Promise.all(
      split(refs, parts, (f) => f.bytes).map((g) =>
        runWorker<WorkerReport & { records: number; problems: string[] }>('verify', {
          session,
          storeDir: w.storeDir,
          latency: w.latency,
          files: g,
          schemas: Object.fromEntries(plan.types.map((t) => [t, crossrefSchema0])),
        } satisfies VerifySpec),
      ),
    )
    const problems = reports.flatMap((x) => x.problems)
    if (problems.length > 0)
      throw new Error(`crossref: verification refused the upload: ${problems[0]}`)
    return reports.reduce((n, x) => n + x.records, 0)
  })
  log(`crossref: verified ${verify.value} records`, { seconds: verify.m.seconds })
  const commit = await measure(store, () =>
    commitVerified(
      store,
      w.collection,
      refs,
      session,
      opts.message ?? 'Crossref, March 2026 public data file',
    ),
  )
  const engine = engineOf(w)
  const first = await measure(store, async () => {
    const h = await engine.open(w.collection)
    const got = await v3.page(store, h.view as v3.View, { type: 'journal-article', limit: 1 })
    return got.length
  })
  if (!opts.append) state(w, 'crossref', { files: 0 }).save()
  return {
    records,
    dumpFiles: files.length,
    duplicates: build.value.reduce((n, b) => n + b.duplicates, 0),
    files: refs.length,
    lineBytes,
    storedBytes,
    storedOverLines: round(storedBytes / lineBytes, 4),
    build: {
      ...brief(build.m),
      recordsPerSecond: Math.round(records / build.m.seconds),
      mbPerCpuSecond: round(lineBytes / MB / build.m.cpuSeconds),
    },
    verify: { ...brief(verify.m), mbPerCpuSecond: round(lineBytes / MB / verify.m.cpuSeconds) },
    commit: {
      ...brief(commit.m),
      number: commit.value.commit.number,
      bytes: commit.value.bytes.byteLength,
    },
    firstRead: { ...brief(first.m), requests: reqs(first.m.requests) },
    stored: await diskUsage(w.storeDir),
  }
}

/**
 * A day of Crossref-shaped changes to the real collection: records picked from
 * dump files spread across the key space, re-sent with the fields a Crossref
 * update changes; a few removed; a few new ones beside them. `share` is the
 * part of the collection a day changes.
 */
async function* crossrefDayRows(
  o: CrossrefOptions,
  files: string[],
  day: number,
  changes: number,
  stream: string,
): AsyncGenerator<v3.LineRow> {
  const r = prng(hash32(`crossref/${stream}/day/${day}`))
  // About 480 records from each of enough files, so a day touches hundreds of key ranges.
  const perFile = 480
  const picks = new Set<number>()
  const want = Math.min(files.length, Math.ceil(changes / perFile))
  while (picks.size < want) picks.add(Math.floor(r() * files.length))
  const share = perFile / 4900
  let made = 0
  for (const i of [...picks].sort((a, b) => a - b)) {
    for await (const line of gzLines(join(o.dataDir, files[i]!))) {
      if (r() >= share || made >= changes) continue
      made++
      const data = JSON.parse(line) as Record<string, unknown> & { DOI: string; type: string }
      const id = data.DOI.toLowerCase()
      const roll = r()
      if (roll < 0.01) {
        yield v3.removalRow(id, data.type)
        continue
      }
      data.indexed = {
        'date-time': `2026-12-${String(1 + (day % 28)).padStart(2, '0')}T00:00:00Z`,
        version: day,
      }
      data['is-referenced-by-count'] = Number(data['is-referenced-by-count'] ?? 0) + day
      if (roll < 0.09) {
        // A new work, next to the one it was made from.
        data.DOI = `${data.DOI}-bench-${stream}-${day}`
        yield v3.rowFromRecord(data.DOI.toLowerCase(), data.type, data)
      } else yield v3.rowFromRecord(id, data.type, data)
    }
  }
}

/** Days of changes to the Crossref collection (or a fork of it), one commit a day. */
export async function crossrefDaily(
  w: World,
  o: CrossrefOptions,
  days: number,
  maintainAfter: boolean,
  opts: { collection?: string; stream?: string; changes?: number } = {},
): Promise<Result> {
  const collection = opts.collection ?? w.collection
  const stream = opts.stream ?? 'main'
  const store = storeOf(w)
  const engine = engineOf(w)
  const { all, files } = dumpFiles(o)
  const changes = opts.changes ?? Math.round((CROSSREF_DAILY * files.length) / all.length)
  const at = state(w, `day-${stream}`, { day: 0 })
  const sample = state<{ type: string; id: string }[]>(w, 'changed-keys', [])
  const rows: Result[] = []
  for (let n = 0; n < days; n++) {
    const day = ++at.value.day
    const kept: { type: string; id: string }[] = []
    const source = (async function* () {
      for await (const row of crossrefDayRows(o, files, day, changes, stream)) {
        if (kept.length < 100 && row.kind === 'r') kept.push({ type: row.type, id: row.id })
        yield row
      }
    })()
    const build = await measure(store, () => engine.build(source))
    const commit = await measure(store, () =>
      engine.commitFiles(collection, build.value, `day ${day}`),
    )
    const row: Result = {
      day,
      commit: commit.value.number,
      changes: commit.value.entries,
      lineBytes: commit.value.lineBytes,
      storedBytes: commit.value.storedBytes,
      build: brief(build.m),
      server: brief(commit.m),
    }
    if (maintainAfter) {
      const m = await measure(store, () => engine.maintain(collection))
      row.maintain = { ...brief(m.m), ...m.value }
      const h = await engine.open(collection)
      row.files = h.files
      row.groups = h.groups
    }
    rows.push(row)
    at.save()
    if (stream === 'main') {
      sample.value = kept
      sample.save()
    }
    log(`crossref daily: day ${day}`, {
      changes: row.changes,
      lineMb: Math.round(commit.value.lineBytes / MB),
      build: build.m.seconds,
      server: commit.m.seconds,
      heapMb: commit.m.peakHeapMb,
    })
  }
  const of = (pick: (r: Result) => number) => summary(rows.map(pick))
  const server = (r: Result) => r.server as ReturnType<typeof brief>
  const written = rows.reduce((n, r) => n + ((r.maintain as { written?: number })?.written ?? 0), 0)
  return {
    days,
    maintain: maintainAfter,
    collection,
    changesPerDay: of((r) => r.changes as number),
    storedBytesPerDay: of((r) => r.storedBytes as number),
    lineBytesPerDay: of((r) => r.lineBytes as number),
    serverSeconds: of((r) => server(r).seconds),
    serverCpuSeconds: of((r) => server(r).cpuSeconds),
    serverRequests: of((r) => server(r).classA + server(r).classB),
    serverClassA: of((r) => server(r).classA),
    serverPeakRssMb: Math.max(...rows.map((r) => server(r).peakRssMb)),
    serverPeakHeapMb: Math.max(...rows.map((r) => server(r).peakHeapMb)),
    buildSeconds: of((r) => (r.build as ReturnType<typeof brief>).seconds),
    ...(maintainAfter
      ? {
          rewrittenBytesPerDay: Math.round(written / days),
          rewrittenBytesTotal: written,
          maintainPeakRssMb: Math.max(
            ...rows.map((r) => (r.maintain as { peakRssMb: number }).peakRssMb),
          ),
          maintainSeconds: of((r) => (r.maintain as { seconds: number }).seconds),
        }
      : {}),
    rows,
    stored: await diskUsage(w.storeDir),
  }
}

/** Keys to read in the Crossref collection: records spread across it, and some a recent day changed. */
export async function crossrefKeys(w: World, n: number): Promise<{ type: string; id: string }[]> {
  const store = storeOf(w)
  const view = await v3.openView(store, w.collection)
  const r = prng(hash32('crossref/keys'))
  const big = view.files.filter((f) => f.first && f.commits[0] === 1)
  const keys: { type: string; id: string }[] = state<{ type: string; id: string }[]>(
    w,
    'changed-keys',
    [],
  ).value.slice(0, Math.floor(n / 4))
  while (keys.length < n && big.length > 0) {
    const f = big[Math.floor(r() * big.length)]!
    const k = r() < 0.5 ? f.first! : f.last!
    keys.push({ type: k[0], id: k[1] })
  }
  return keys
}

/** Fork the Crossref collection, edit 1% of the fork, then change both daily and track what is shared. */
export async function crossrefForks(w: World, o: CrossrefOptions, days: number): Promise<Result> {
  const store = storeOf(w)
  const engine = engineOf(w)
  const fork = `${w.collection}-fork`
  const before = await diskUsage(w.storeDir)
  const forked = await measure(store, () => engine.fork(w.collection, fork))
  const after = await diskUsage(w.storeDir)
  const recordBytesAdded = (after.records?.bytes ?? 0) - (before.records?.bytes ?? 0)
  log('crossref fork', { ...forked.value, seconds: forked.m.seconds, recordBytesAdded })
  const edit = await crossrefDaily(w, o, 1, true, {
    collection: fork,
    stream: 'fork-edit',
    changes: Math.round(CROSSREF_RECORDS * 0.01),
  })
  let t = Date.now()
  const account = async (day: number) => {
    for (let i = 0; i < 3; i++)
      await v3.sweep(store, { graceMs: 0, trashMs: 0, now: () => (t += 1) })
    const s = await v3.sweep(store, { graceMs: 0, trashMs: 0, now: () => (t += 1) })
    const p = s.logical.get(w.collection)?.bytes ?? 0
    const f = s.logical.get(fork)?.bytes ?? 0
    const physical = s.records.listedBytes
    return {
      day,
      parentBytes: p,
      forkBytes: f,
      physicalBytes: physical,
      sharedShare: f > 0 ? round((p + f - physical) / f, 4) : 0,
      missing: s.records.missing.length,
    }
  }
  const track = [await account(0)]
  log('crossref forks: day 0', track[0])
  let rewritten = edit.rewrittenBytesTotal as number
  for (let n = 1; n <= days; n++) {
    const a = await crossrefDaily(w, o, 1, true)
    const b = await crossrefDaily(w, o, 1, true, { collection: fork, stream: 'fork' })
    rewritten += (a.rewrittenBytesTotal as number) + (b.rewrittenBytesTotal as number)
    if (n % 5 === 0 || n === days) {
      track.push(await account(n))
      log(`crossref forks: day ${n}`, track[track.length - 1])
    }
  }
  return {
    fork: { ...brief(forked.m), ...forked.value, recordBytesAdded },
    edit: {
      entries: (edit.changesPerDay as { mean: number }).mean,
      storedBytes: (edit.storedBytesPerDay as { mean: number }).mean,
      serverSeconds: (edit.serverSeconds as { mean: number }).mean,
      buildSeconds: (edit.buildSeconds as { mean: number }).mean,
    },
    days,
    rewrittenBytes: rewritten,
    track,
  }
}

/** A schema change on one Crossref type: one that only relaxes, and one that makes the server scan. */
export async function crossrefSchema(w: World, type: string): Promise<Result> {
  const store = storeOf(w)
  const engine = engineOf(w)
  const change = async (body: unknown) => {
    const upload = await engine.build([v3.rowFromRecord(type, v3.SCHEMA_TYPE, body)])
    const m = await measure(store, () => engine.commitFiles(w.collection, upload, 'schema'))
    return { ...brief(m.m), semver: m.value.semver, scanned: m.value.scanned }
  }
  const relaxed = await change({ ...crossrefSchema0, required: ['DOI'] })
  const stricter = await change({ ...crossrefSchema0, required: ['DOI', 'type', 'URL'] })
  log('crossref schema', {
    type,
    relaxed: relaxed.seconds,
    stricter: stricter.seconds,
    scanned: stricter.scanned,
  })
  return {
    type,
    relaxed,
    stricter: { ...stricter, recordsPerSecond: Math.round(stricter.scanned / stricter.seconds) },
  }
}

/**
 * What the stored sorted-record-files are made of: record blocks, key blocks,
 * footers and trailers, from each file's own footer. Read off disk, so it
 * counts no requests.
 */
export async function storageSplit(w: World): Promise<Result> {
  const store = storeOf(w)
  const out = {
    files: 0,
    bytes: 0,
    recordBlocks: 0,
    keyBlocks: 0,
    footers: 0,
    lines: 0,
    entries: 0,
  }
  const labeled = { ...out }
  for await (const key of listAll(store.inner, 'records/')) {
    const f = await v3.SortedFile.open(store.inner, key)
    const records = f.locator.recordBlocks.reduce((n, b) => n + b, 0)
    const keys = f.locator.keyBlocks.reduce((n, b) => n + b, 0)
    for (const t of f.content.labeled ? [out, labeled] : [out]) {
      t.files++
      t.bytes += f.size
      t.recordBlocks += records
      t.keyBlocks += keys
      t.footers += f.size - records - keys
      t.lines += f.content.bytes
      t.entries += f.content.entries
    }
  }
  const disk = await diskUsage(w.storeDir)
  log('storage split', out)
  return {
    all: out,
    rebuilt: labeled,
    keyBlockShare: round(out.keyBlocks / Math.max(1, out.bytes), 4),
    keyBytesPerEntry: round(out.keyBlocks / Math.max(1, out.entries), 1),
    storedOverLines: round(out.bytes / Math.max(1, out.lines), 4),
    stored: disk,
  }
}

/**
 * What the key cut is for, measured on a collection that is already loaded (on forks of it,
 * so it is not changed): how much is rewritten to take one record down, and to merge
 * everything back together keeping the files no change fell in.
 */
export async function cutBenefit(w: World): Promise<Result> {
  const store = storeOf(w)
  const engine = engineOf(w)
  const cut = { cutBytes: w.cutBytes, maxBytes: w.maxBytes ?? 4 * w.cutBytes }
  const sizeOf = async (f: v3.LayoutFile) =>
    f.size ?? (await store.inner.head(v3.recordKey(f.id)))?.size ?? 0
  const before = (await v3.currentFiles(store.inner, w.collection)).files
  const load = before.filter((f) => !f.labeled && f.commits[0] === 1)
  const loadBytes = (await Promise.all(load.map(sizeOf))).reduce((n, b) => n + b, 0)
  const stamp = Date.now().toString(36)

  // 1. Take down one record of the first load: the first key of the load's middle file.
  const victim = load[Math.floor(load.length / 2)]!
  const key = { type: victim.first![0], id: victim.first![1] }
  const t = `${w.collection}-takedown-${stamp}`
  await engine.fork(w.collection, t)
  const groups = v3.groupsOf((await v3.currentFiles(store.inner, t)).files)
  const plan = await v3.planGroupsHolding(store.inner, groups, [key])
  const takedown = await measure(store, () =>
    v3.rebuild(store, t, {
      plan: () => plan,
      takedown: (type, id) => type === key.type && id === key.id,
      takedownKeys: [key],
      ...cut,
    }),
  )
  const gone = await v3.getRecord(store, await v3.openView(store, t), key.type, key.id)
  if (!gone || gone.line !== null) throw new Error('cut benefit: the record was not withheld')

  // 2. Merge everything back together, keeping the files no change fell in.
  const m = `${w.collection}-merged-${stamp}`
  await engine.fork(w.collection, m)
  const merge = await measure(store, () =>
    v3.rebuild(store, m, { plan: v3.planAll, keepUntouched: true, ...cut }),
  )
  const after = (await v3.currentFiles(store.inner, m)).files
  const result = {
    cutBytes: Number.isFinite(w.cutBytes) ? w.cutBytes : null,
    load: {
      files: load.length,
      storedBytes: loadBytes,
      meanFileBytes: Math.round(loadBytes / load.length),
    },
    groupsBefore: groups.length,
    takedown: {
      ...brief(takedown.m),
      groupsHolding: plan.length,
      filesRewritten: takedown.value.filesIn - takedown.value.kept,
      kept: takedown.value.kept,
      written: takedown.value.written,
    },
    merge: {
      ...brief(merge.m),
      filesIn: merge.value.filesIn,
      kept: merge.value.kept,
      filesRewritten: merge.value.filesIn - merge.value.kept,
      filesOut: merge.value.filesOut,
      written: merge.value.written,
      groupsAfter: v3.groupsOf(after).length,
    },
  }
  log('cut benefit', {
    files: result.load.files,
    meanFileMb: round(result.load.meanFileBytes / MB),
    takedownWrittenMb: round(result.takedown.written / MB),
    takedownSeconds: takedown.m.seconds,
    mergeWrittenMb: round(result.merge.written / MB),
    mergeKept: result.merge.kept,
    mergeSeconds: merge.m.seconds,
  })
  return result
}

/**
 * The fork test for cutting by key (v3-build-plan.md, "From a collaborator's
 * review"): load a collection cut toward a target file size, fork it, edit one
 * record in the fork, and rebuild the fork into one group of files, keeping every file
 * the edit did not fall in. Measures what the fork costs to store, before and
 * after that rebuild, for each target size.
 */
export async function forkEdit(
  w: World,
  targetsMb: number[],
  /** Days to follow a fork's sharing: under the tier rule, and merging all, untouched files kept. */
  days: { tier: number; keep: number } = { tier: 0, keep: 0 },
): Promise<Result> {
  const rows: Result[] = []
  for (const mb of targetsMb) {
    const collection = `cut${String(mb).replace('.', '_')}`
    const fork = `${collection}-fork`
    // Generated records store at about 0.27 of their lines' bytes.
    const cutBytes = Math.round((mb * MB) / 0.27)
    const cw: World = { ...w, collection, cutBytes }
    const store = storeOf(cw)
    const engine = engineOf(cw)
    const loaded = await load(cw)
    const before = await diskUsage(cw.storeDir)
    const forked = await measure(store, () => engine.fork(collection, fork))
    const wl = loadWorkload(cw)
    const i = wl.pick(prng(hash32(`fork-edit/${mb}`)))
    const edited = record(wl.seed, i, 1)
    const edit = await measure(store, () =>
      engine.commit(fork, [v3.rowFromRecord(edited.id, edited.type, edited.data)]),
    )
    /** What the parent lists, what the fork lists, and what the two take to store together. */
    const account = async (parentName = collection, forkName = fork) => {
      const sizes = new Map<string, number>()
      const listed = async (c: string) => {
        let bytes = 0
        const { files } = await v3.currentFiles(store.inner, c)
        for (const f of files) {
          const size = f.size ?? (await store.inner.head(v3.recordKey(f.id)))?.size ?? 0
          sizes.set(f.id, size)
          bytes += size
        }
        return { bytes, files }
      }
      const parent = await listed(parentName)
      const child = await listed(forkName)
      const together = [...sizes.values()].reduce((n, b) => n + b, 0)
      return {
        parentBytes: parent.bytes,
        forkBytes: child.bytes,
        // What the fork adds to the location over its parent.
        extraBytes: together - parent.bytes,
        // Of what the fork lists, the share stored once for both.
        sharedShare:
          child.bytes > 0 ? round((parent.bytes + child.bytes - together) / child.bytes, 4) : 0,
        forkFiles: child.files.length,
        forkGroups: v3.groupsOf(child.files).length,
      }
    }
    /**
     * How sharing fades: a parent and its fork (forks of the loaded collection, so nothing is
     * loaded again), the fork edited by 1%, then a day's changes to each and a rebuild of
     * each, day after day. `tier` rebuilds by the policy in force; `keep` merges everything
     * each day, leaving files no change fell in as they are.
     */
    const fade = async (policy: 'tier' | 'keep', n: number) => {
      const p = `${collection}-${policy}`
      const f = `${p}-fork`
      await engine.fork(collection, p)
      await engine.fork(p, f)
      const pw = loadWorkload(cw)
      const fw = pw.fork(`fade-${policy}-${mb}`)
      // Days of their own for each target and policy: the same day's rows would build the
      // same files, which are stored once, and nothing would count as rewritten.
      const first = 1000 * (1 + targetsMb.indexOf(mb) * 2 + (policy === 'keep' ? 1 : 0))
      const settle = async (c: string) =>
        policy === 'tier'
          ? (await engine.maintain(c)).written
          : (
              await v3.rebuild(store, c, {
                plan: v3.planAll,
                cutBytes,
                maxBytes: 4 * cutBytes,
                keepUntouched: true,
                cache: engine.cache,
              })
            ).written
      const t0 = performance.now()
      await engine.commit(f, dayRows(fw, 100_000 + first, 0.01))
      let rewritten = await settle(f)
      const track = [{ day: 0, rewrittenBytes: rewritten, ...(await account(p, f)) }]
      for (let day = 1; day <= n; day++) {
        await engine.commit(p, dayRows(pw, first + day, w.rate))
        await engine.commit(f, dayRows(fw, first + day, w.rate))
        rewritten += (await settle(p)) + (await settle(f))
        if (day <= 2 || day % 5 === 0 || day === n) {
          track.push({ day, rewrittenBytes: rewritten, ...(await account(p, f)) })
          log(`fork fade, ${mb} MB files, ${policy}: day ${day}`, track[track.length - 1])
        }
      }
      return {
        days: n,
        seconds: round((performance.now() - t0) / 1000, 1),
        rewrittenBytes: rewritten,
        track,
      }
    }
    /**
     * The other end from an edit spread over the whole collection: 1% of the records, next
     * to each other in key order, edited on a fork and merged keeping untouched files.
     */
    const near = async () => {
      const f = `${collection}-near`
      await engine.fork(collection, f)
      const h = await engine.open(collection)
      const want = Math.max(1, Math.round(w.records * 0.01))
      const text = new TextDecoder()
      async function* rows(): AsyncGenerator<v3.LineRow> {
        let made = 0
        const from = { type: edited.type, id: edited.id }
        for await (const rec of v3.exportAll(store, h.view as v3.View, { from })) {
          if (!rec.line) continue
          const { data } = JSON.parse(text.decode(rec.line)) as { data: Record<string, unknown> }
          yield v3.rowFromRecord(rec.id, rec.type, {
            ...data,
            version: Number(data.version ?? 0) + 1,
          })
          if (++made >= want) return
        }
      }
      const made = await engine.commit(f, rows())
      const m = await measure(store, () =>
        v3.rebuild(store, f, {
          plan: v3.planAll,
          cutBytes,
          maxBytes: 4 * cutBytes,
          keepUntouched: true,
          cache: engine.cache,
        }),
      )
      const a = await account(collection, f)
      log(`fork edit, ${mb} MB files, 1% side by side`, {
        entries: made.entries,
        extra: a.extraBytes,
        kept: m.value.kept,
        filesIn: m.value.filesIn,
      })
      return {
        entries: made.entries,
        editBytes: made.storedBytes,
        seconds: m.m.seconds,
        kept: m.value.kept,
        filesIn: m.value.filesIn,
        written: m.value.written,
        ...a,
      }
    }
    // Under the tier rule alone the edit sits in its own small file: nothing is rewritten.
    const tiered = await account()
    const fold = await measure(store, () =>
      v3.rebuild(store, fork, {
        plan: v3.planAll,
        cutBytes,
        maxBytes: 4 * cutBytes,
        keepUntouched: true,
        cache: engine.cache,
      }),
    )
    const folded = await account()
    const key = { type: edited.type, id: edited.id }
    const h = await engine.open(fork)
    const read = await timed(store, 20, () => engine.readPoint(h, key.type, key.id))
    const after = await diskUsage(cw.storeDir)
    const row = {
      targetMb: mb,
      cutBytes,
      files: loaded.files,
      storedBytes: loaded.storedBytes,
      meanFileBytes: Math.round((loaded.storedBytes as number) / (loaded.files as number)),
      fork: { ...brief(forked.m), ...forked.value },
      edit: { ...brief(edit.m), storedBytes: edit.value.storedBytes },
      tiered,
      fold: {
        ...brief(fold.m),
        kept: fold.value.kept,
        filesIn: fold.value.filesIn,
        filesOut: fold.value.filesOut,
        written: fold.value.written,
      },
      folded,
      readAfter: read,
      recordBytesAdded: (after.records?.bytes ?? 0) - (before.records?.bytes ?? 0),
      ...(days.tier > 0 || days.keep > 0 ? { near: await near() } : {}),
      ...(days.tier > 0 ? { fadeTier: await fade('tier', days.tier) } : {}),
      ...(days.keep > 0 ? { fadeKeep: await fade('keep', days.keep) } : {}),
    }
    rows.push(row)
    log(`fork edit, ${mb} MB files`, {
      files: row.files,
      meanFileMb: round(row.meanFileBytes / MB),
      tieredExtra: tiered.extraBytes,
      foldedExtra: folded.extraBytes,
      rewritten: row.fold.written,
      kept: row.fold.kept,
      foldSeconds: fold.m.seconds,
    })
  }
  return { records: w.records, targets: rows }
}
