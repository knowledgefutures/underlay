/**
 * A suite's world: its folder, its store, the generator's state, and the
 * settings every scenario of the suite shares.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fileStore, v3 } from '../../packages/protocol/src/index.js'
import { benchDir } from '../src/dirs.js'
import { type GenRecord, idOf, schemas, typeOf, Workload } from '../src/gen.js'
import { V3Engine } from './engine.js'
import { BenchStore } from './store.js'

/** Crossref: 97,600 changes a day over 179.5M records (the plan's figure). */
export const CROSSREF_RECORDS = 179_518_552
export const CROSSREF_DAILY = 97_600
export const DAILY_RATE = CROSSREF_DAILY / CROSSREF_RECORDS
/** Crossref's lines are 1.07 TB over those records: about 6 KB each. */
export const CROSSREF_LINE_BYTES = 1_074_725_199_630

export interface World {
  suite: string
  /** The suite's folder: store/, scratch/, and the generator's state. */
  dir: string
  storeDir: string
  resultsDir: string
  latency: string
  /** Records in the first load. */
  records: number
  seed: number
  workers: number
  collection: string
  /** Share of live records a day changes. */
  rate: number
  /** The rebuild policy's tiers, scaled so a day's upload sits in the tier it does at Crossref's size. */
  tiers: v3.TierOptions
  /**
   * Files are cut by key toward this many bytes of lines: the reference client's 128 MiB at
   * Crossref's size, scaled down with the collection (never under 4 MiB) so that a smaller
   * load still has files by the thousand, as Crossref's has.
   */
  cutBytes: number
  /** Gzip level for built files. */
  level?: number
}

export function world(suite: string, opts: Partial<World> & { records: number }): World {
  const dir = join(benchDir(), 'v3', suite)
  mkdirSync(join(dir, 'store'), { recursive: true })
  mkdirSync(join(dir, 'scratch'), { recursive: true })
  const resultsDir = join(benchDir(), 'v3', 'results')
  mkdirSync(resultsDir, { recursive: true })
  const scale = opts.records / CROSSREF_RECORDS
  return {
    suite,
    dir,
    storeDir: join(dir, 'store'),
    resultsDir,
    latency: 'r2',
    seed: 42,
    workers: 8,
    collection: 'main',
    rate: DAILY_RATE,
    // At Crossref's size a day's upload (0.6 GB of lines) is two tiers above the 8 MiB base.
    tiers: { ratio: 10, baseBytes: Math.max(4096, Math.round(8 * 1024 * 1024 * scale)) },
    cutBytes: Math.min(
      v3.CUT_BYTES,
      Math.max(4 * 1024 * 1024, Math.round((CROSSREF_LINE_BYTES * scale) / 8192)),
    ),
    ...opts,
  }
}

/** One store for each folder and latency profile in a process, so its counts are in one place. */
const stores = new Map<string, BenchStore>()
export function storeOf(w: World, latency = w.latency): BenchStore {
  const key = `${w.storeDir}\n${latency}`
  let s = stores.get(key)
  if (!s) stores.set(key, (s = new BenchStore(w.storeDir, latency)))
  return s
}

export function engineOf(w: World, latency = w.latency, opts: { verify?: boolean } = {}): V3Engine {
  return new V3Engine(storeOf(w, latency), {
    tiers: w.tiers,
    cutBytes: w.cutBytes,
    scratch: fileStore(join(w.dir, 'scratch')),
    ...(w.level === undefined ? {} : { level: w.level }),
    ...opts,
  })
}

// --- The generator's state ---

const workloadFile = (w: World, name: string) => join(w.dir, `workload-${name}.bin`)

export function loadWorkload(w: World, name = w.collection, seed = w.seed): Workload {
  const file = workloadFile(w, name)
  return existsSync(file) ? Workload.load(file, seed) : new Workload(seed, w.records)
}
export function saveWorkload(w: World, wl: Workload, name = w.collection): void {
  wl.save(workloadFile(w, name))
}

/** Small state a suite keeps between steps (which day it is on, and such). */
export function state<T>(w: World, name: string, initial: T): { value: T; save(): void } {
  const file = join(w.dir, `state-${name}.json`)
  const s = {
    value: existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : initial,
    save: () => writeFileSync(file, JSON.stringify(s.value)),
  }
  return s
}

// --- Rows ---

export const rowOf = (r: GenRecord): v3.LineRow => v3.rowFromRecord(r.id, r.type, r.data)

/** A `$schema` row for every generated type. */
export function schemaRows(): v3.LineRow[] {
  return Object.entries(schemas())
    .map(([type, body]) => v3.rowFromRecord(type, v3.SCHEMA_TYPE, body))
    .sort(v3.compareKey)
}

/** One day's changes as rows, in no order. */
export function* dayRows(wl: Workload, day: number, rate: number): Generator<v3.LineRow> {
  const batch = wl.day(day, rate)
  for (const r of wl.records(batch)) yield rowOf(r)
  for (const d of wl.deletions(batch)) yield v3.removalRow(d.id, d.type)
}

/** A live record's key, picked by a random source. */
export function pickKey(wl: Workload, r: () => number): { type: string; id: string } {
  const i = wl.pick(r)
  return { type: typeOf(wl.seed, i), id: idOf(wl.seed, i) }
}
