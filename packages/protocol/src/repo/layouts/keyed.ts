import type { RecordEntry } from '../../tree/node.js'
/**
 * Layout F (record-storage-layout.md): records in packs, found through an index
 * keyed by (type, id, record hash), with no map per leaf. Everything is per collection:
 * its packs, index and manifest live under its own prefix (`runs/<collection>/`),
 * the manifest as objects (no database), so a collection is maintained on its own
 * and a mirror copies its files as written. A fork reads its parent's files where
 * they are (HomeStore); the parent keeps whatever a live fork lists.
 *
 * A commit unit appends its new records to packs in key order and its index
 * entries as one layer. A maintain job then merges what's due: adjacent layers
 * into one, and small packs of a tier into one, re-pointing their records in a
 * new layer. Reclaiming keeps only what a mark found live.
 *
 * Every read and merge holds a bounded amount however large the collection: an
 * index read takes a few layers at a time and keeps only the keys it wants, a
 * merge's reads share a fixed budget (`mergeRead`), and writers write as they go.
 */
import { compareUtf8 } from '../../utf8.js'
import type { Lru } from '../lru.js'
import { PrefixedStore, type Store } from '../types.js'
import {
  FANOUT,
  LAYER_FANOUT,
  type LayerInfo,
  type PendingRun,
  LayerReader,
  LayeredIndex,
  levelFor,
  RunWriter,
  runEntries,
  runs,
  type Manifest,
  ManifestStore,
  mergeRead,
  mergeSorted,
  PackRegistry,
  newId,
  type PackInfo,
  PackReader,
  type PackHooks,
  PackWriter,
  packDirKey,
  packKey,
  parseLoc,
  topSeq,
  layerDirKey,
  layerFilterKey,
  layerKey,
  filterKey,
} from './kit.js'
import {
  LEVEL_RATIO,
  levelConfig,
  type LevelShard,
  LevelShards,
  levelRaw,
  levelTargets,
  MAX_LEVEL,
  shardKey,
} from './levels.js'
import { type KeyRange, LiveHashes } from './reclaim.js'
import {
  type LiveSet,
  type PackRecord,
  recordKey,
  type RecordStore,
  type RecordWriter,
  type TypedLeaf,
  type UploadWriter,
} from './types.js'

/** Index entries a reclaim range job works on: its live set is 8 bytes an entry. */
export const RECLAIM_RANGE_ENTRIES = 250_000

/**
 * Index runs past which a reclaim waits for merges: each range job reads every run
 * at once (a share of `mergeRead`'s budget each, and each one's directory).
 */
export const RECLAIM_MAX_RUNS = 32

/** A reclaim asked for while the index has more than RECLAIM_MAX_RUNS runs: merge, then ask again. */
export class TooManyRunsError extends Error {}

/** A reclaim's snapshot of the index and packs, and the key ranges its jobs work in. */
export interface ReclaimPlan {
  id: string
  layers: LayerInfo[]
  packs: { id: string; records: number }[]
  ranges: KeyRange[]
  /** The registry objects read (the swap replaces them). */
  registry: string[]
  /** Where the new run goes: the plan's lowest level and newest sequence (newer commits still win). */
  level: number
  seq: number
}

interface RangeResult {
  files: LayerInfo[]
  perPack: Record<string, number>
  kept: number
  dropped: number
}

const reclaimKey = (plan: string, name: string) => `reclaim/${plan}/${name}`

/**
 * A merge of more than layoutConfig.mergeJobEntries index entries (a large
 * collection's biggest runs: past 5 minutes of CPU at 12M records) is split
 * into key ranges, a job each, and swapped in whole when the last is done.
 * A split merge not swapped in by then is abandoned (a range job that never ran), and its output deleted. */
const MERGE_ABANDON_MS = 60 * 60_000

/** A merge split into key ranges: its inputs, the ranges, and where its run goes. */
export interface MergePlan {
  id: string
  layers: LayerInfo[]
  ranges: KeyRange[]
  level: number
  seq: number
  at: number
}

const mergeKey = (plan: string, name: string) => `merges/${plan}/${name}`

/** Whether a level lists the same shards in both (nothing changed it between). */
const sameShards = (a: readonly LevelShard[] | undefined, b: readonly LevelShard[] | undefined) =>
  (a ?? []).map((s) => s.id).join() === (b ?? []).map((s) => s.id).join()

export interface MaintainOptions {
  /**
   * Run a merge too large for one job as range jobs (the server queues
   * `layout.merge` for each). Without it every merge runs here.
   */
  split?: (plan: MergePlan) => Promise<void>
}

/** A maintain lease older than this (a queue job's 15-minute wall clock) belonged to a job that died. */
const MAINTAIN_LEASE_MS = 16 * 60_000

/** Stored bytes of small packs one pack merge takes (up to `layoutConfig.mergeInputs` packs). */
const MERGE_PACKS_BYTES = 16 * 1024 * 1024

/** Index runs past which the fewest-entry adjacent ones merge regardless of size. */
const MAX_RUNS = 10

/** Packs under this many stored bytes, times 8 per tier, are merged eight at a time. */
const SMALL_PACK = 4 * 1024 * 1024
const MAX_PACK_TIER = 3
/**
 * An upload's pack this large (raw) is listed with the packs no merge takes: a bulk
 * load's batches (8 MB each) are written once, where they stay. Merging them was
 * the external sort again, one pack at a time on the set's one maintain lane.
 * Smaller ones (a small push's) are merged like a commit's.
 */
export const UPLOAD_PACK_FINAL_RAW = 1024 * 1024
/** Commits whose uploads' packs a manifest remembers listing (`Manifest.adopted`). */
const ADOPTED_KEPT = 1000
/** Present in a leveled collection's prefix (`KeyedLayout.markLeveled`). */
const LEVELED_KEY = 'manifest/f/leveled.json'

/** How long a replaced object stays readable (readers holding an older manifest). */
export const layoutConfig = {
  graceMs: 60_000,
  /** Index entries one merge job takes before it's split into key-range jobs (tests set it low). */
  mergeJobEntries: 1_000_000,
  /** How long one maintain job merges (one pass at least) before leaving the rest to the next. */
  maintainBudgetMs: 10 * 60_000,
  /**
   * Storage calls one maintain job makes before leaving the rest to the next: Workers
   * allow 10,000 subrequests an invocation, and the pass that crosses this, the sweep
   * and settling the manifest fit in the rest (round 19: a 12M load's 354 units left
   * one job ~10,460).
   */
  maintainCalls: 6_000,
  /** Index entries a commit's writer holds before writing them out as a run (tests set it low). */
  writerRunEntries: 20_000,
  /**
   * Index runs, or packs, one merge takes at most: each is two reads, so a pass's
   * calls stay well inside what `maintainCalls` leaves (tests set it low).
   */
  mergeInputs: 128,
  /**
   * Level a collection's packs when its first write finds it empty (levels.ts); one
   * holding packs already stays tiered. The server switches it on.
   */
  levelNew: false,
}

/**
 * `store`, counting its storage calls into `n` (a Worker's subrequests). A proxy keeps
 * `instanceof` and a store class's own methods, which run on the store itself (their
 * calls aren't counted: a few at most a job).
 */
function counted<S extends Store>(store: S, n: { calls: number }): S {
  const io = new Set(['get', 'head', 'put', 'list', 'delete', 'putParts', 'putPieces', 'copy'])
  return new Proxy(store, {
    get(t, k) {
      const v = Reflect.get(t, k, t) as unknown
      if (typeof v !== 'function') return v
      const f = v as (...a: unknown[]) => unknown
      return io.has(String(k))
        ? (...a: unknown[]) => {
            n.calls++
            return f.apply(t, a)
          }
        : f.bind(t)
    },
  })
}

/** A leaf's record that the set's index doesn't hold (its other set may). */
export class MissingRecordError extends Error {}

export class KeyedLayout implements RecordStore {
  readonly manifests: ManifestStore
  /** Packs no merge will take again (the manifest lists only the ones merges still may). */
  readonly registry: PackRegistry
  readonly packs: PackReader
  readonly index: LayeredIndex
  readonly layers: LayerReader
  /** A leveled collection's level listings (levels.ts). */
  readonly levels: LevelShards

  /** Every storage call this layout makes goes through `store`, counted here. */
  readonly #io = { calls: 0 }
  readonly store: Store
  #leveled: { v: Promise<boolean>; retry: number } | null = null

  readonly name = 'f'

  constructor(
    store: Store,
    readonly lru: Lru<unknown>,
    readonly scope: string,
  ) {
    this.store = store = counted(store, this.#io)
    this.manifests = new ManifestStore(store, this.name)
    this.registry = new PackRegistry(store, this.name)
    this.packs = new PackReader(store, lru, scope)
    this.index = new LayeredIndex(store, lru, scope, this.manifests)
    this.layers = this.index.reader
    this.levels = new LevelShards(store)
  }

  /** Whether no pack merge will take `p` again: it then lives in the registry, not the manifest. */
  static final(p: PackInfo): boolean {
    return p.tier >= MAX_PACK_TIER || p.bytes >= SMALL_PACK * 8 ** p.tier
  }

  /**
   * Whether this collection's packs are leveled (levels.ts): marked once (`markLeveled`),
   * by its first write while `layoutConfig.levelNew` is on, or by a fork of one that is.
   * A collection holding packs when leveling was switched on stays tiered. Remembered
   * once known.
   */
  leveled(): Promise<boolean> {
    if (!this.#leveled || Date.now() > this.#leveled.retry) {
      const known = { v: Promise.resolve(false), retry: Infinity }
      known.v = this.#isLeveled(known)
      this.#leveled = known
    }
    return this.#leveled.v
  }

  async #isLeveled(known: { retry: number }): Promise<boolean> {
    if (await this.store.head(LEVELED_KEY)) return true
    if (!layoutConfig.levelNew) {
      // Read again later: leveling may be switched on meanwhile (the next write decides).
      known.retry = Date.now() + 5000
      return false
    }
    const m = await this.manifests.latest()
    const empty = !m.layers.length && !m.packs.length && !(await this.registry.read()).keys.length
    if (empty) {
      await this.store.put(LEVELED_KEY, '{}', { ifAbsent: true })
      return true
    }
    // Another writer may have marked it just as this one looked.
    return (await this.store.head(LEVELED_KEY)) !== null
  }

  /** Make this collection leveled, before anything is written to it. */
  async markLeveled(): Promise<void> {
    await this.store.put(LEVELED_KEY, '{}', { ifAbsent: true })
    this.#leveled = { v: Promise.resolve(true), retry: Infinity }
  }

  /**
   * Whether `p` is listed in the registry rather than the manifest or a level: in a
   * leveled collection only history packs are (every other is merged again).
   */
  #final(p: PackInfo, leveled: boolean): boolean {
    return leveled ? !!p.history : KeyedLayout.final(p)
  }

  /** Every pack of levels 1… , by level. */
  async #levelPacks(m: Manifest): Promise<Map<number, PackInfo[]>> {
    const out = new Map<number, PackInfo[]>()
    for (const [l, shards] of Object.entries(m.levels ?? {}))
      if (shards.length) out.set(Number(l), await this.levels.packs(shards))
    return out
  }

  /** Every pack: the manifest's, the levels' and the registry's (reclaim, forks). */
  async allPacks(): Promise<PackInfo[]> {
    const m = await this.manifests.latest()
    return [
      ...m.packs,
      ...[...(await this.#levelPacks(m)).values()].flat(),
      ...(await this.#registered(m)).packs,
    ]
  }

  /**
   * The registry's objects, and its packs `m` doesn't list: a reclaim lists the packs
   * it will rewrite in the manifest, then takes them out of the registry, so for a
   * moment a pack can be in both.
   */
  async #registered(m: Manifest): Promise<{ keys: string[]; packs: PackInfo[] }> {
    const r = await this.registry.read()
    const listed = new Set(m.packs.map((p) => p.id))
    return { keys: r.keys, packs: r.packs.filter((p) => !listed.has(p.id)) }
  }

  /** Each entry's place: a few keys through the filters, a leaf's as one range of its type's. */
  async #find(
    m: Manifest,
    type: string,
    entries: readonly RecordEntry[],
  ): Promise<(string | undefined)[]> {
    const keys = entries.map((e) => recordKey(type, e.key, e.hash))
    const found = await this.index.values(m, keys)
    return keys.map((k) => found.get(k))
  }

  async leafLines(leaf: TypedLeaf): Promise<string[]> {
    if (!leaf.entries.length) return []
    try {
      return await this.#leafLines(leaf, await this.manifests.current())
    } catch (err) {
      // A head behind the newest manifest (F moves it at most once a second) can name
      // files a merge has since swept: read again from the newest.
      if (!(err instanceof Error) || !/^Missing (pack|layer)/.test(err.message)) throw err
      return this.#leafLines(leaf, await this.manifests.latest())
    }
  }

  async #leafLines(leaf: TypedLeaf, m: Manifest): Promise<string[]> {
    let found = await this.#find(m, leaf.type, leaf.entries)
    // Another isolate may have committed since this one read the manifest.
    if (found.some((x) => x === undefined))
      found = await this.#find(await this.manifests.latest(), leaf.type, leaf.entries)
    const missing = found.findIndex((x) => x === undefined)
    if (missing >= 0) {
      const e = leaf.entries[missing]!
      throw new MissingRecordError(
        `Layout ${this.name}: leaf ${leaf.hash} has no stored ${leaf.type} record ${e.key} (${e.hash})`,
      )
    }
    return this.packs.lines(found as string[])
  }

  linesAt(leaf: TypedLeaf, at: readonly number[]): Promise<string[]> {
    return this.leafLines({ ...leaf, entries: at.map((i) => leaf.entries[i]!) })
  }

  async entryLine(leaf: TypedLeaf, i: number): Promise<string> {
    return (await this.linesAt(leaf, [i]))[0]!
  }

  writer(opts: { hold?: boolean } = {}): RecordWriter {
    return new KeyedWriter(this, opts)
  }

  /**
   * A writer of an upload's records into packs of its own, outside the index and the
   * manifest until a commit names them (adoptPacks). Their places go in the push's
   * runs, so a commit indexes the records without moving them. Records arriving in
   * key order (an upload sent sorted) stream straight into whole packs; one below the
   * last starts a new pack.
   */
  uploadWriter(hooks: PackHooks = {}): UploadWriter {
    const pw = new PackWriter(this.store, { hooks })
    return {
      append: (r) => pw.append(recordKey(r.type, r.id, r.hash), r.line),
      ready: () => pw.ready(),
      finish: () => pw.finish(),
    }
  }

  /** An upload's records into packs, sorted first: their places, in the order given. */
  async writePacks(
    records: readonly PackRecord[],
    hooks: PackHooks = {},
  ): Promise<{ places: string[]; packs: PackInfo[] }> {
    const w = this.uploadWriter(hooks)
    const keys = records.map((r) => recordKey(r.type, r.id, r.hash))
    const order = keys.map((_, i) => i).sort((a, b) => compareUtf8(keys[a]!, keys[b]!))
    const places: string[] = Array.from({ length: records.length })
    let n = 0
    for (const i of order) {
      places[i] = w.append(records[i]!)
      if (++n % 1024 === 0) await w.ready()
    }
    return { places, packs: await w.finish() }
  }

  /**
   * List packs uploads wrote, once the commit's index names their records (after its
   * runs are appended: a merge re-points a pack's records in a newer layer, which a
   * commit's layer folded in later would otherwise override with the old places).
   * Large ones go in the registry, small ones in the manifest for merges. Once only
   * a `name`: a retry finds it in `adopted` and lists nothing.
   */
  async adoptPacks(name: string, packs: readonly PackInfo[]): Promise<void> {
    if (!packs.length) return
    if ((await this.manifests.latest()).adopted?.includes(name)) return
    if (await this.leveled()) return this.#adoptLeveled(name, packs)
    const large = (p: PackInfo) => p.raw >= UPLOAD_PACK_FINAL_RAW || KeyedLayout.final(p)
    // A fixed key: written once even if this stops before the manifest says so.
    await this.registry.add(packs.filter(large), `upload-${name}`)
    const small = packs.filter((p) => !large(p))
    await this.manifests.update((m) => {
      if (m.adopted?.includes(name)) return null
      const have = new Set(m.packs.map((p) => p.id))
      m.packs.push(...small.filter((p) => !have.has(p.id)))
      m.adopted = [...(m.adopted ?? []), name].slice(-ADOPTED_KEPT)
      return m
    })
  }

  /**
   * Leveled: an upload's packs go to level 0, to be merged down. But a load sent in
   * key order (packs that never overlap) into an empty collection is already what
   * the bottom level is: listed there as written, never rewritten to get there (a
   * Crossref-sized load, 1 TB, would otherwise go down every level).
   */
  async #adoptLeveled(name: string, packs: readonly PackInfo[]): Promise<void> {
    const sorted = [...packs].sort((a, b) => compareUtf8(a.lo ?? '', b.lo ?? ''))
    const disjoint = sorted.every(
      (p, i) => p.lo && p.hi && (i === 0 || compareUtf8(p.lo, sorted[i - 1]!.hi!) > 0),
    )
    const empty = (m: Manifest) =>
      !m.packs.length && !Object.values(m.levels ?? {}).some((s) => s.length)
    if (disjoint && empty(await this.manifests.latest())) {
      const shards = await this.levels.write(sorted.map((p) => ({ ...p, level: MAX_LEVEL })))
      let placed = false
      await this.manifests.update((m) => {
        if (m.adopted?.includes(name) || !empty(m)) return null
        m.levels = { ...m.levels, [MAX_LEVEL]: shards }
        m.adopted = [...(m.adopted ?? []), name].slice(-ADOPTED_KEPT)
        placed = true
        return m
      })
      if (placed) return
      // Something landed first: level 0 after all (or a retry already listed them).
      for (const s of shards) await this.store.delete(shardKey(s.id))
    }
    await this.manifests.update((m) => {
      if (m.adopted?.includes(name)) return null
      const have = new Set(m.packs.map((p) => p.id))
      m.packs.push(...packs.filter((p) => !have.has(p.id)))
      m.adopted = [...(m.adopted ?? []), name].slice(-ADOPTED_KEPT)
      return m
    })
  }

  /**
   * Delete packs an upload wrote for commit `name`, but none the collection lists:
   * a pack `adoptPacks` named (in the manifest, its retired files, or the registry
   * object it wrote) goes only by reclaim. The ids deleted.
   */
  async dropPacks(name: string, ids: readonly string[]): Promise<string[]> {
    const m = await this.manifests.latest()
    const listed = new Set([...m.packs.map((p) => p.id), ...m.retired.map((r) => r.key)])
    const registered = await this.store.get(this.registry.keyFor(`upload-${name}`))
    if (registered)
      for (const p of JSON.parse(await registered.text()) as PackInfo[]) listed.add(p.id)
    for (const ps of (await this.#levelPacks(m)).values()) for (const p of ps) listed.add(p.id)
    const gone = ids.filter((id) => !listed.has(id) && !listed.has(packKey(id)))
    for (let i = 0; i < gone.length; i += 16)
      await Promise.all(
        gone
          .slice(i, i + 16)
          .flatMap((id) => [this.store.delete(packKey(id)), this.store.delete(packDirKey(id))]),
      )
    return gone
  }

  /** A commit's runs its units held back (RecordWriter.finish), as one pending object. */
  appendRuns(runs: PendingRun[]): Promise<void> {
    return this.manifests.appendRuns(runs)
  }

  /**
   * Merges and sweeps due on this store. One at a time per store: every commit
   * queues a maintain job, and with thousands of collections committing into one
   * location's index the jobs piled up, each working out the same merge for one of
   * them to swap in (20,000 collections: the bulk queue full of them, loads ~10×
   * slower). A job that finds another holding the lease leaves at once: the holder
   * reads the manifest again each pass, so it takes in what that commit added
   * (and the next commit's job takes in anything after).
   *
   * True when a budget ended it with merges perhaps still due: the caller queues
   * another job, as a load's last commit has no next commit to.
   */
  async maintain(opts: MaintainOptions = {}): Promise<boolean> {
    const lease = await this.#lease()
    if (!lease) return false
    const start = this.#io.calls
    const spent = () => this.#io.calls - start
    let more = false
    try {
      // A layer merge and a pack merge each pass, until neither is due: with commits
      // landing throughout, layers alone could keep a job busy and packs pile up. A
      // job stops well inside its lease and a Worker's subrequests; the next carries on.
      const until = Date.now() + layoutConfig.maintainBudgetMs
      const leveled = await this.leveled()
      for (;;) {
        const layers = await this.#mergeLayers(opts.split)
        const packs = leveled ? await this.#mergeLevels() : await this.#mergePacks()
        if (!layers && !packs) break
        if (Date.now() >= until || spent() >= layoutConfig.maintainCalls) {
          more = true
          break
        }
      }
      // What's left of the budget, or a few at least: the rest waits for the next job.
      if (!(await this.#sweepRetired(Math.max(16, layoutConfig.maintainCalls - spent()))))
        more = true
      await this.manifests.settle()
    } finally {
      await lease()
    }
    return more
  }

  /** The store's maintain lease, or null if another job holds it; the result releases it. */
  async #lease(): Promise<(() => Promise<void>) | null> {
    const key = 'maintain/lease'
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = newId()
      await this.store.put(key, JSON.stringify({ token, at: Date.now() }), { ifAbsent: true })
      // The holder can release between the get and the read; that reads as not held.
      const v = await this.store
        .get(key)
        .then(async (held) =>
          held ? (JSON.parse(await held.text()) as { token: string; at: number }) : null,
        )
        .catch(() => null)
      if (v?.token === token) return () => this.#release(key, token)
      // A lease older than a job can run is a job that died holding it.
      if (!v || Date.now() - v.at < MAINTAIN_LEASE_MS) return null
      await this.#release(key, v.token)
    }
    return null
  }

  /**
   * Delete the lease if `token` still holds it: a job that ran past its lease, which
   * another then took, mustn't release the new holder's. The store has no conditional
   * delete, so a takeover between this read and the delete still loses it; the window
   * is one request, not the rest of a job.
   */
  async #release(key: string, token: string): Promise<void> {
    const held = await this.store
      .get(key)
      .then(async (o) => (o ? (JSON.parse(await o.text()) as { token: string }).token : null))
      .catch(() => null)
    if (held === token) await this.store.delete(key)
  }

  /**
   * Merge the newest runs, while each older one is no larger than all the newer
   * ones together, when there are LAYER_FANOUT of them or more. A merged run
   * takes its newest input's sequence number, which is only right when no other
   * run's number falls between its inputs': so merges only ever take runs next
   * to each other in sequence, newest first (as RocksDB's universal compaction).
   * Small commits merge with each other; a large run (an initial load's) joins
   * once the newer ones add up to its size; each older run is at least as large
   * as all newer ones, so there are about log2 of the entries' runs at most.
   */
  async #mergeLayers(split?: MaintainOptions['split']): Promise<boolean> {
    // A split merge's inputs stay one block until it swaps in; runs between such
    // blocks merge as usual, adjacent among themselves, so every block stays one.
    // At 20,000 collections (round 12) commits added ~200 runs a minute, and
    // stopping every merge while a split merge's ranges waited in the queue left
    // hundreds of runs.
    const blocked = new Set(
      (split ? await this.#mergesInFlight() : []).flatMap((p) => runs(p.layers).map((r) => r.id)),
    )
    const m = await this.manifests.latest()
    const all = runs(m.layers).sort((a, b) => b.seq - a.seq)
    const size = (r: (typeof all)[number]) => r.files.reduce((n, f) => n + f.entries, 0)
    // Stretches of adjacent runs no split merge holds, newest first.
    const free: (typeof all)[] = [[]]
    for (const r of all)
      if (!blocked.has(r.id)) free.at(-1)!.push(r)
      else if (free.at(-1)!.length) free.push([])
    let inputs: typeof all | null = null
    for (const rs of free) {
      let take = 1
      let newer = rs.length ? size(rs[0]!) : 0
      while (take < rs.length && size(rs[take]!) <= newer) newer += size(rs[take++]!)
      if (take >= LAYER_FANOUT) {
        inputs = rs.slice(0, take)
        break
      }
    }
    // Too many runs (small ones stranded behind a larger one, which the rule above
    // never reaches; a pack merge's run, the newest when written, strands all before
    // it): merge the longest stretch of adjacent runs no larger than the smallest
    // that must go, so one merge brings the count back near MAX_RUNS. Four at a time
    // fell behind ~3 commits a second (round 13 at 20,000 collections: 114 runs).
    // A lookup checks every run, so their number is a read cost on every commit.
    if (!inputs && all.length > MAX_RUNS) {
      const cap = all.map(size).sort((a, b) => a - b)[all.length - MAX_RUNS]!
      for (const rs of free)
        for (let i = 0; i < rs.length;) {
          let j = i
          while (j < rs.length && size(rs[j]!) <= cap) j++
          if (j - i >= 2 && j - i > (inputs?.length ?? 0)) inputs = rs.slice(i, j)
          i = j + 1
        }
      // None adjacent: the LAYER_FANOUT adjacent runs with the fewest entries.
      if (!inputs) {
        let least = Infinity
        for (const rs of free)
          for (let i = 0; i + LAYER_FANOUT <= rs.length; i++) {
            const n = rs.slice(i, i + LAYER_FANOUT).reduce((t, r) => t + size(r), 0)
            if (n < least) {
              least = n
              inputs = rs.slice(i, i + LAYER_FANOUT)
            }
          }
      }
    }
    if (!inputs) return false
    // The newest of them: still adjacent; the next pass takes the rest.
    inputs = inputs.slice(0, layoutConfig.mergeInputs)
    if (split && inputs.reduce((n, r) => n + size(r), 0) > layoutConfig.mergeJobEntries) {
      await split(await this.mergePlan(inputs.flatMap((r) => r.files)))
      // Its inputs are a block now; other runs may still merge.
      return true
    }
    const out = new RunWriter(this.store, Math.max(...inputs.map((r) => r.level)))
    let n = 0
    // Entries of dropped packs never reach a merge: reclaim rewrites the index as it drops them.
    const read = mergeRead(inputs.length)
    for await (const [k, v] of mergeSorted(
      inputs.map((r) => runEntries(this.layers, r.files, undefined, undefined, read)),
    )) {
      out.add(k, v)
      if (++n % 1024 === 0) await out.ready()
    }
    const files = await out.finish(Math.max(...inputs.map((r) => r.seq)))
    return this.#swap({
      oldLayers: inputs.flatMap((r) => r.files.map((f) => f.id)),
      newLayers: files,
      keepSeq: true,
    })
  }

  /**
   * Merge eight small packs of a tier and type into one, re-pointing their records in
   * a new layer. A merge takes one type's packs, so its output holds one type and a
   * type's records gather in fewer packs (a leaf read of one type at three years of
   * Crossref dailies, simulated: 72 GETs at the median where mixing types took 255).
   * Packs from before types were recorded merge among themselves.
   */
  async #mergePacks(): Promise<boolean> {
    const m = await this.manifests.latest()
    const queues = new Map<string, { tier: number; packs: PackInfo[] }>()
    for (const p of m.packs) {
      if (KeyedLayout.final(p)) continue
      const q = `${p.tier}\u0000${p.type ?? ''}`
      const queue = queues.get(q) ?? { tier: p.tier, packs: [] }
      queue.packs.push(p)
      queues.set(q, queue)
    }
    // The queue with the most packs: the lowest tier that has enough never runs out
    // while commits land, so higher tiers never merged (round 14 at 20,000
    // collections: 718 tier-1 packs listed and rising).
    let queue: { tier: number; packs: PackInfo[] } | undefined
    for (const q of queues.values()) if (q.packs.length > (queue?.packs.length ?? 0)) queue = q
    if (!queue || queue.packs.length < FANOUT) return false
    const tier = queue.tier
    // As many of the queue's packs as fit MERGE_PACKS_BYTES stored (at least FANOUT): many
    // collections' tiny commits each write a tiny pack, and eight at a time fell behind
    // (6,639 waiting at 15,000 collections, every commit reading them all).
    const inputs: PackInfo[] = []
    let stored = 0
    for (const p of queue.packs) {
      if (
        inputs.length >= FANOUT &&
        (stored + p.bytes > MERGE_PACKS_BYTES || inputs.length >= layoutConfig.mergeInputs)
      )
        break
      inputs.push(p)
      stored += p.bytes
    }
    const reader = this.packs
    const read = mergeRead(inputs.length)
    const streams = inputs.map((p) =>
      (async function* () {
        for await (const { key, line } of reader.all(p.id, read))
          yield [key, line] as [string, string]
      })(),
    )
    const pw = new PackWriter(this.store, { tier: tier + 1 })
    const lw = new RunWriter(this.store, 0)
    let n = 0
    for await (const [key, line] of mergeSorted(streams)) {
      lw.add(key, pw.append(key, line))
      if (++n % 1024 === 0) await Promise.all([pw.ready(), lw.ready()])
    }
    const packs = await pw.finish()
    const files = await lw.finish()
    return this.#swap({ oldPacks: inputs.map((p) => p.id), newLayers: files, newPacks: packs })
  }

  /**
   * Leveled: one merge down, from the level most over its target (levels.ts). Level 0's
   * oldest packs merge into the base level; a pack of a level below it merges into
   * the next, picking the one whose overlap there is smallest for its size (RocksDB's
   * kMinOverlappingRatio: each merge rewrites as little as it can). Both sides go
   * through as streams into the next level's packs, cut at 16 MiB and at types, and a
   * new layer points the index at where each record now is.
   *
   * A record id found with several hashes keeps the newest (level 0's newest pack,
   * then the upper level) in the levels; the older hashes go to this month's history
   * packs. That's a guess at which is current: a revert brings back an old hash, then
   * read from history. Only locality depends on it, since the index says where every
   * copy is.
   */
  async #mergeLevels(): Promise<boolean> {
    const m = await this.manifests.latest()
    const { base, targets } = levelTargets(m.levels)
    const zero = m.packs.filter((p) => !p.history)
    const zeroRaw = zero.reduce((n, p) => n + p.raw, 0)
    // Level 0 merges once it's a tenth of the level it merges into: while a collection
    // is small its base is the bottom, and a few small commits shouldn't rewrite it all.
    const zeroTrigger = Math.max(levelConfig.level0Raw, levelRaw(m.levels, base) / LEVEL_RATIO)
    let from = -1
    let score = 1
    if (zero.length >= levelConfig.level0Packs || zeroRaw >= zeroTrigger) {
      from = 0
      score = Math.max(zero.length / levelConfig.level0Packs, zeroRaw / zeroTrigger)
    }
    for (let l = 1; l < MAX_LEVEL; l++) {
      const raw = levelRaw(m.levels, l)
      if (!raw) continue
      // A level above the base has no room: what it holds goes down first.
      const s = targets[l]! > 0 ? raw / targets[l]! : Infinity
      if (s > score) {
        from = l
        score = s
      }
    }
    if (from < 0) return false
    let upper: PackInfo[]
    let target: number
    if (from === 0) {
      // Oldest first, so what stays in level 0 is newer than what went down.
      upper = []
      let raw = 0
      for (const p of zero) {
        if (upper.length && raw + p.raw > levelConfig.level0MergeRaw) break
        upper.push(p)
        raw += p.raw
      }
      target = base
    } else {
      target = from + 1
      const here = await this.levels.packs(m.levels?.[from] ?? [])
      const below = await this.levels.packs(m.levels?.[target] ?? [])
      // Each pack's overlap below, by a walk of both in key order.
      let best: PackInfo | null = null
      let bestRatio = Infinity
      let j = 0
      for (const p of here) {
        while (j < below.length && compareUtf8(below[j]!.hi!, p.lo!) < 0) j++
        let over = 0
        for (let k = j; k < below.length && compareUtf8(below[k]!.lo!, p.hi!) <= 0; k++)
          over += below[k]!.raw
        const ratio = (over + 1) / Math.max(1, p.raw)
        if (ratio < bestRatio) {
          best = p
          bestRatio = ratio
        }
      }
      upper = [best!]
    }
    const lo = upper.reduce((a, p) => (compareUtf8(p.lo!, a) < 0 ? p.lo! : a), upper[0]!.lo!)
    const hi = upper.reduce((a, p) => (compareUtf8(p.hi!, a) > 0 ? p.hi! : a), upper[0]!.hi!)
    const lower = await this.levels.overlapping(m.levels?.[target] ?? [], lo, hi)
    // Newest first: level 0's newest pack, …, its oldest, then the level below.
    const ranked = [...(from === 0 ? [...upper].reverse() : upper), ...lower]
    const reader = this.packs
    const read = mergeRead(ranked.length)
    const streams = ranked.map((p, rank) =>
      (async function* () {
        for await (const { key, line } of reader.all(p.id, read)) yield { key, line, rank }
      })(),
    )
    const month = new Date().toISOString().slice(0, 7)
    const pw = new PackWriter(this.store, { level: target, packRaw: levelConfig.packRaw })
    const hw = new PackWriter(this.store, { history: month, packRaw: levelConfig.packRaw })
    const lw = new RunWriter(this.store, 0)
    let group: { key: string; line: string; rank: number }[] = []
    let n = 0
    const flush = async () => {
      if (!group.length) return
      let cur = group[0]!
      for (const x of group) if (x.rank < cur.rank) cur = x
      let last = ''
      for (const x of group) {
        // A copy of a key already written (the same record twice) is one record.
        if (x.key === last) continue
        if (x.key === cur.key) {
          if (x !== cur) continue
          lw.add(x.key, pw.append(x.key, x.line))
        } else lw.add(x.key, hw.append(x.key, x.line))
        last = x.key
      }
      group = []
      if (++n % 64 === 0) await Promise.all([pw.ready(), hw.ready(), lw.ready()])
    }
    for await (const x of mergeAll(streams)) {
      const id = x.key.slice(0, x.key.lastIndexOf('\u0000'))
      if (group.length) {
        const g = group[0]!.key
        if (g.slice(0, g.lastIndexOf('\u0000')) !== id) await flush()
      }
      group.push(x)
    }
    await flush()
    const packs = await pw.finish()
    const history = await hw.finish()
    const files = await lw.finish()
    return this.#swapLevels({
      zero: from === 0 ? upper.map((p) => p.id) : [],
      from: from > 0 ? { level: from, ids: upper.map((p) => p.id) } : null,
      target,
      lower: lower.map((p) => p.id),
      packs,
      history,
      layers: files,
    })
  }

  /**
   * A leveled merge's result in one manifest change: its inputs out of level 0 or
   * their level, its output in the target level, its history packs in the registry,
   * and its layer the newest. Only if the levels it changed are as it read them and
   * level 0's inputs are still listed; otherwise everything it wrote goes.
   */
  async #swapLevels(o: {
    zero: string[]
    from: { level: number; ids: string[] } | null
    target: number
    lower: string[]
    packs: PackInfo[]
    history: PackInfo[]
    layers: LayerInfo[]
  }): Promise<boolean> {
    const m0 = await this.manifests.latest()
    const changed = new Map<number, Awaited<ReturnType<LevelShards['replace']>>>()
    if (o.from)
      changed.set(
        o.from.level,
        await this.levels.replace(m0.levels?.[o.from.level] ?? [], new Set(o.from.ids), []),
      )
    changed.set(
      o.target,
      await this.levels.replace(m0.levels?.[o.target] ?? [], new Set(o.lower), o.packs),
    )
    const registered = await this.registry.add(o.history)
    const zero = new Set(o.zero)
    let lost = false
    await this.manifests.update((m) => {
      const have = new Set(m.packs.map((p) => p.id))
      if (
        ![...zero].every((id) => have.has(id)) ||
        [...changed.keys()].some((l) => !sameShards(m.levels?.[l], m0.levels?.[l]))
      ) {
        lost = true
        return null
      }
      const now = Date.now()
      m.packs = m.packs.filter((p) => !zero.has(p.id))
      m.levels = { ...m.levels }
      for (const [l, c] of changed) m.levels[l] = c.shards
      const seq = topSeq(m) + 1
      for (const l of o.layers) m.layers.push({ ...l, seq })
      for (const id of [...o.zero, ...(o.from?.ids ?? []), ...o.lower])
        m.retired.push({ key: packKey(id), at: now }, { key: packDirKey(id), at: now })
      for (const c of changed.values())
        for (const id of c.replaced) m.retired.push({ key: shardKey(id), at: now })
      m.stats.levelMerges = (m.stats.levelMerges ?? 0) + 1
      return m
    })
    if (!lost) return true
    const gone = [
      ...o.layers.flatMap((l) => [layerKey(l.id), layerDirKey(l.id), layerFilterKey(l.id)]),
      ...[...o.packs, ...o.history].flatMap((p) => [packKey(p.id), packDirKey(p.id)]),
      ...[...changed.values()].flatMap((c) => c.written.map(shardKey)),
      ...(registered ? [registered] : []),
    ]
    for (let i = 0; i < gone.length; i += 16)
      await Promise.all(gone.slice(i, i + 16).map((k) => this.store.delete(k)))
    return false
  }

  /**
   * Replace layers and packs in one manifest change: only if every input the
   * manifest lists is still there (another job may have merged them first);
   * otherwise drop what was written. New packs no merge will take are listed in
   * the registry, the rest in the manifest; `unlisted` are old packs already in
   * neither (reclaim took them out of the registry), retired with the rest. In a
   * leveled collection old packs a level lists come out of its shards (only if the
   * level is as read), and new packs go to level 0 but for history packs.
   */
  async #swap(o: {
    oldLayers?: string[]
    oldPacks?: string[]
    unlisted?: string[]
    newLayers?: LayerInfo[]
    newPacks?: PackInfo[]
    /** Registry packs to list in the manifest too (reclaim's, until their rewrite swaps them out). */
    relist?: PackInfo[]
    /** New layers keep their sequence (a merged run); else they're the newest (re-pointed records). */
    keepSeq?: boolean
  }): Promise<boolean> {
    const oldLayers = new Set(o.oldLayers ?? [])
    const oldPacks = new Set(o.oldPacks ?? [])
    const newLayers = o.newLayers ?? []
    const newPacks = o.newPacks ?? []
    const leveled = await this.leveled()
    const listed = newPacks.filter((p) => !this.#final(p, leveled))
    const registered = await this.registry.add(newPacks.filter((p) => this.#final(p, leveled)))
    const m0 = leveled ? await this.manifests.latest() : null
    const changed = new Map<number, Awaited<ReturnType<LevelShards['replace']>>>()
    const inLevels = new Set<string>()
    if (m0) {
      const gone = new Set([...oldPacks, ...(o.unlisted ?? [])])
      for (const [l, ps] of await this.#levelPacks(m0)) {
        const ids = new Set(ps.filter((p) => gone.has(p.id)).map((p) => p.id))
        if (!ids.size) continue
        for (const id of ids) inLevels.add(id)
        changed.set(l, await this.levels.replace(m0.levels![l]!, ids, []))
      }
    }
    let lost = false
    await this.manifests.update((m) => {
      const haveL = new Set(m.layers.map((l) => l.id))
      const haveP = new Set(m.packs.map((p) => p.id))
      if (
        ![...oldLayers].every((id) => haveL.has(id)) ||
        ![...oldPacks].every((id) => haveP.has(id) || inLevels.has(id)) ||
        [...changed.keys()].some((l) => !sameShards(m.levels?.[l], m0!.levels?.[l]))
      ) {
        lost = true
        return null
      }
      const now = Date.now()
      m.layers = m.layers.filter((l) => !oldLayers.has(l.id))
      m.packs = m.packs.filter((p) => !oldPacks.has(p.id))
      if (changed.size) {
        m.levels = { ...m.levels }
        for (const [l, c] of changed) {
          m.levels[l] = c.shards
          for (const id of c.replaced) m.retired.push({ key: shardKey(id), at: now })
        }
      }
      // A pack merge's layer is the newest: its places win over the old ones.
      const seq = topSeq(m) + 1
      for (const l of newLayers) m.layers.push(o.keepSeq ? l : { ...l, seq })
      const have = new Set(m.packs.map((p) => p.id))
      m.packs.push(...listed, ...(o.relist ?? []).filter((p) => !have.has(p.id)))
      for (const id of oldLayers)
        m.retired.push(
          { key: layerKey(id), at: now },
          { key: layerDirKey(id), at: now },
          { key: layerFilterKey(id), at: now },
        )
      for (const id of [...oldPacks, ...(o.unlisted ?? [])])
        m.retired.push({ key: packKey(id), at: now }, { key: packDirKey(id), at: now })
      return m
    })
    if (lost) {
      for (const l of newLayers)
        await Promise.all([
          this.store.delete(layerKey(l.id)),
          this.store.delete(layerDirKey(l.id)),
          this.store.delete(layerFilterKey(l.id)),
        ])
      for (const p of newPacks)
        await Promise.all([this.store.delete(packKey(p.id)), this.store.delete(packDirKey(p.id))])
      for (const c of changed.values())
        await Promise.all(c.written.map((id) => this.store.delete(shardKey(id))))
      if (registered) await this.store.delete(registered)
      return false
    }
    return true
  }

  /** Delete retired objects past their grace, `limit` at most; false if some are left for later. */
  async #sweepRetired(limit = Infinity): Promise<boolean> {
    const m = await this.manifests.current(0)
    const cutoff = Date.now() - layoutConfig.graceMs
    let due = m.retired.filter((r) => r.at < cutoff)
    if (!due.length) return true
    // F: a live fork may still read what this collection merged away; those stay
    // retired (swept once the fork goes) rather than deleted.
    if (this.store instanceof HomeStore) {
      const kept = await this.store.forkHeld()
      due = due.filter((r) => !kept.has(fileId(r.key) ?? ''))
      if (!due.length) return true
    }
    const all = due.length
    due = due.slice(0, limit)
    for (let i = 0; i < due.length; i += 16)
      await Promise.all(due.slice(i, i + 16).map((r) => this.store.delete(r.key)))
    const gone = new Set(due.map((r) => r.key))
    await this.manifests.update((n) => {
      n.retired = n.retired.filter((r) => !gone.has(r.key))
      return n
    })
    return due.length === all
  }

  /** The whole reclaim in this process, from a mark of every live record (small stores, tests). */
  async reclaim(live: LiveSet): Promise<Record<string, number>> {
    const h = new LiveHashes()
    for (const k of live.records) {
      const z = k.lastIndexOf('\u0000')
      h.add(k.slice(0, z), k.slice(z + 1))
    }
    const plan = await this.reclaimPlan()
    for (let i = 0; i < plan.ranges.length; i++) await this.reclaimRange(plan, i, h)
    const swapped = await this.reclaimSwap(plan)
    if (!swapped) return {}
    for (let i = 0; i < swapped.rewrite.length; i += 4)
      await this.reclaimRewrite(swapped.rewrite.slice(i, i + 4))
    return swapped.stats
  }

  // --- Reclaim a key range at a time (the server's bounded jobs: cleanup/layout-reclaim.ts) ---

  /**
   * Step 1: the index and packs as they are now, and the key ranges to work in,
   * each of about `rangeEntries` index entries. Saved for the range jobs.
   */
  /** Key ranges over `layers` of about `rangeEntries` entries each, cut at record ids. */
  async #cutRanges(layers: readonly LayerInfo[], rangeEntries: number): Promise<KeyRange[]> {
    // Cut points from the layers' page keys, sampled to keep a plan small.
    const cuts: [string, number][] = []
    const total = layers.reduce((n, l) => n + l.entries, 0)
    for (const l of layers) {
      const { keys, perPage } = await this.layers.pageKeys(l)
      const every = Math.max(1, Math.floor(keys.length / Math.max(1, (l.entries / total) * 50_000)))
      for (let i = 0; i < keys.length; i += every) cuts.push([filterKey(keys[i]!), perPage * every])
    }
    cuts.sort((a, b) => compareUtf8(a[0], b[0]))
    const ranges: KeyRange[] = []
    let lo: string | null = null
    let n = 0
    for (const [k, w] of cuts) {
      if (n >= rangeEntries && (lo === null || compareUtf8(k, lo) > 0)) {
        ranges.push({ lo, hi: k })
        lo = k
        n = 0
      }
      n += w
    }
    ranges.push({ lo, hi: null })
    return ranges
  }

  // --- A merge split into key ranges (the server's `layout.merge` jobs) ---

  /** Plan a merge of `layers` (adjacent runs' files) as key-range jobs. */
  async mergePlan(
    layers: LayerInfo[],
    rangeEntries = layoutConfig.mergeJobEntries,
  ): Promise<MergePlan> {
    const plan: MergePlan = {
      id: newId(),
      layers,
      ranges: await this.#cutRanges(layers, rangeEntries),
      level: Math.max(0, ...layers.map((l) => l.level)),
      seq: Math.max(...layers.map((l) => l.seq)),
      at: Date.now(),
    }
    await this.store.put(mergeKey(plan.id, 'plan'), JSON.stringify(plan))
    return plan
  }

  async mergePlanById(id: string): Promise<MergePlan | null> {
    const o = await this.store.get(mergeKey(id, 'plan'))
    return o ? (JSON.parse(await o.text()) as MergePlan) : null
  }

  /** One range of a split merge: its part of the merged run. Whether every range is now done. */
  async mergeRange(plan: MergePlan, i: number): Promise<boolean> {
    // Its inputs merged elsewhere (another maintain, which only a broken lease allows):
    // nothing to swap in, and waiting for it to be abandoned would hold up merges.
    const have = new Set((await this.manifests.latest()).layers.map((l) => l.id))
    if (!plan.layers.every((l) => have.has(l.id))) {
      await this.#dropMerge(plan, true)
      return false
    }
    const r = plan.ranges[i]!
    const out = new RunWriter(this.store, plan.level)
    const inputs = runs(plan.layers).sort((a, b) => b.seq - a.seq)
    const read = mergeRead(inputs.length)
    let n = 0
    for await (const [k, v] of mergeSorted(
      inputs.map((x) =>
        runEntries(this.layers, x.files, r.lo ?? undefined, r.hi ?? undefined, read),
      ),
    )) {
      out.add(k, v)
      if (++n % 1024 === 0) await out.ready()
    }
    const files = await out.finish(plan.seq)
    await this.store.put(
      mergeKey(plan.id, `range-${String(i).padStart(6, '0')}`),
      JSON.stringify(files),
    )
    return (await this.#listed(mergeKey(plan.id, 'range-'))).length >= plan.ranges.length
  }

  /**
   * Swap a split merge's run in for its inputs, once (the first caller claims it).
   * False when another caller has it, or its inputs went meanwhile (its output is deleted).
   */
  async mergeSwap(plan: MergePlan): Promise<boolean> {
    const token = newId()
    await this.store.put(mergeKey(plan.id, 'swap'), token, { ifAbsent: true })
    if ((await (await this.store.get(mergeKey(plan.id, 'swap')))?.text()) !== token) return false
    const files: LayerInfo[] = []
    for (let i = 0; i < plan.ranges.length; i++) {
      const o = await this.store.get(mergeKey(plan.id, `range-${String(i).padStart(6, '0')}`))
      if (!o) {
        await this.#dropMerge(plan, false)
        return false
      }
      files.push(...(JSON.parse(await o.text()) as LayerInfo[]))
    }
    const level = Math.max(plan.level, levelFor(files.reduce((n, f) => n + f.entries, 0)))
    const swapped = await this.#swap({
      oldLayers: plan.layers.map((l) => l.id),
      newLayers: files.map((f) => ({ ...f, level, seq: plan.seq, run: plan.id })),
      keepSeq: true,
    })
    await this.#dropMerge(plan, false)
    await this.manifests.settle()
    return swapped
  }

  async #listed(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.store.list(prefix, cursor)
      keys.push(...page.keys)
      cursor = page.cursor
    } while (cursor)
    return keys
  }

  /** The split merges under way; one past MERGE_ABANDON_MS is abandoned and cleared. */
  async #mergesInFlight(): Promise<MergePlan[]> {
    const out: MergePlan[] = []
    for (const key of await this.#listed('merges/')) {
      if (!key.endsWith('/plan')) continue
      const plan = await this.mergePlanById(key.slice('merges/'.length, -'/plan'.length))
      if (!plan) continue
      if (Date.now() - plan.at > MERGE_ABANDON_MS) await this.#dropMerge(plan, true)
      else out.push(plan)
    }
    return out
  }

  /** A split merge's objects gone; with `outputs`, the layer files its ranges wrote too. */
  async #dropMerge(plan: MergePlan, outputs: boolean) {
    const keys = [mergeKey(plan.id, 'plan')]
    for (let i = 0; i < plan.ranges.length; i++) {
      const key = mergeKey(plan.id, `range-${String(i).padStart(6, '0')}`)
      keys.push(key)
      if (!outputs) continue
      const o = await this.store.get(key)
      if (o)
        for (const f of JSON.parse(await o.text()) as LayerInfo[])
          keys.push(layerKey(f.id), layerDirKey(f.id), layerFilterKey(f.id))
    }
    for (let i = 0; i < keys.length; i += 16)
      await Promise.all(keys.slice(i, i + 16).map((k) => this.store.delete(k)))
    await this.store.delete(mergeKey(plan.id, 'swap'))
  }

  async reclaimPlan(rangeEntries = RECLAIM_RANGE_ENTRIES): Promise<ReclaimPlan> {
    const m = await this.manifests.latest()
    const n = runs(m.layers).length
    if (n > RECLAIM_MAX_RUNS)
      throw new TooManyRunsError(`Reclaim: ${n} index runs, more than ${RECLAIM_MAX_RUNS}`)
    const ranges = await this.#cutRanges(m.layers, rangeEntries)
    const registry = await this.#registered(m)
    const levelPacks = [...(await this.#levelPacks(m)).values()].flat()
    const plan: ReclaimPlan = {
      id: newId(),
      layers: m.layers,
      packs: [...m.packs, ...levelPacks, ...registry.packs].map((p) => ({
        id: p.id,
        records: p.records,
      })),
      registry: registry.keys,
      ranges,
      level: Math.max(0, ...m.layers.map((l) => l.level)),
      // Inherited layers (a fork's) number below zero.
      seq: m.layers.length ? Math.max(...m.layers.map((l) => l.seq)) : 0,
    }
    await this.store.put(reclaimKey(plan.id, 'plan'), JSON.stringify(plan))
    return plan
  }

  async reclaimPlanById(id: string): Promise<ReclaimPlan> {
    const o = await this.store.get(reclaimKey(id, 'plan'))
    if (!o) throw new Error(`No reclaim plan ${id}`)
    return JSON.parse(await o.text()) as ReclaimPlan
  }

  /**
   * Step 2, one job a range: the plan's index entries in the range that `live`
   * holds, written as files of the range's part of one new run, with live
   * records counted per pack. Returns whether every range is now done.
   */
  async reclaimRange(plan: ReclaimPlan, i: number, live: LiveHashes): Promise<boolean> {
    const r = plan.ranges[i]!
    const from = r.lo ?? undefined
    const to = r.hi ?? undefined
    const packs = new Set(plan.packs.map((p) => p.id))
    const perPack: Record<string, number> = {}
    let kept = 0
    let dropped = 0
    const out = new RunWriter(this.store, plan.level)
    const inputs = runs(plan.layers).sort((a, b) => b.seq - a.seq)
    const read = mergeRead(inputs.length)
    for await (const [k, v] of mergeSorted(
      inputs.map((x) => runEntries(this.layers, x.files, from, to, read)),
    )) {
      const pack = parseLoc(v).pack
      const z = k.lastIndexOf('\u0000')
      if (!packs.has(pack) || !live.has(k.slice(0, z), k.slice(z + 1))) {
        dropped++
        continue
      }
      out.add(k, v)
      perPack[pack] = (perPack[pack] ?? 0) + 1
      if (++kept % 1024 === 0) await out.ready()
    }
    const files = await out.finish(plan.seq)
    const result: RangeResult = { files, perPack, kept, dropped }
    await this.store.put(
      reclaimKey(plan.id, `range-${String(i).padStart(6, '0')}`),
      JSON.stringify(result),
    )
    let done = 0
    let cursor: string | undefined
    do {
      const page = await this.store.list(reclaimKey(plan.id, 'range-'), cursor)
      done += page.keys.length
      cursor = page.cursor
    } while (cursor)
    return done >= plan.ranges.length
  }

  /**
   * Step 3, once every range is done (and only once: the first caller claims it):
   * swap the ranges' run in for the plan's layers, drop packs with nothing live,
   * and return the packs under half live, for rewrite jobs. Null when another
   * caller has it, or a merge replaced the plan's layers meanwhile (nothing changes).
   */
  async reclaimSwap(
    plan: ReclaimPlan,
  ): Promise<{ rewrite: string[]; stats: Record<string, number> } | null> {
    const token = newId()
    await this.store.put(reclaimKey(plan.id, 'swap'), token, { ifAbsent: true })
    if ((await (await this.store.get(reclaimKey(plan.id, 'swap')))?.text()) !== token) return null
    const files: LayerInfo[] = []
    const live = new Map<string, number>()
    const stats = {
      ranges: plan.ranges.length,
      entriesKept: 0,
      entriesDropped: 0,
      packs: plan.packs.length,
      packsDropped: 0,
      packsRewritten: 0,
      recordsDropped: 0,
    }
    for (let i = 0; i < plan.ranges.length; i++) {
      const o = await this.store.get(reclaimKey(plan.id, `range-${String(i).padStart(6, '0')}`))
      // Gone: another job swapped this plan in and dropped it (and the claim this one just made again).
      if (!o) {
        await this.store.delete(reclaimKey(plan.id, 'swap'))
        return null
      }
      const r = JSON.parse(await o.text()) as RangeResult
      files.push(...r.files.map((f) => ({ ...f, seq: plan.seq, run: plan.id })))
      for (const [p, n] of Object.entries(r.perPack)) live.set(p, (live.get(p) ?? 0) + n)
      stats.entriesKept += r.kept
      stats.entriesDropped += r.dropped
    }
    const drop: string[] = []
    const rewrite: string[] = []
    for (const p of plan.packs) {
      const n = live.get(p.id) ?? 0
      if (n === 0) drop.push(p.id)
      else if (n < p.records / 2) rewrite.push(p.id)
      stats.recordsDropped += p.records - n
    }
    stats.packsDropped = drop.length
    stats.packsRewritten = rewrite.length
    // One run across the ranges, at the level its whole size puts it.
    const level = Math.max(plan.level, levelFor(stats.entriesKept))
    for (const f of files) f.level = level
    const registered: PackInfo[] = []
    for (const key of plan.registry) {
      const o = await this.store.get(key)
      if (o) registered.push(...(JSON.parse(await o.text()) as PackInfo[]))
    }
    const m = await this.manifests.latest()
    const listed = new Set(m.packs.map((p) => p.id))
    const rewriting = new Set(rewrite)
    const swapped = await this.#swap({
      oldLayers: plan.layers.map((l) => l.id),
      oldPacks: drop.filter((id) => listed.has(id)),
      unlisted: drop.filter((id) => !listed.has(id)),
      newLayers: files,
      // Registry packs being rewritten move to the manifest: listed somewhere until
      // their rewrite swaps them out (else a reclaim planned meanwhile drops their
      // live records, and a fork or a mirror misses them).
      relist: registered.filter((p) => rewriting.has(p.id)),
      keepSeq: true,
    })
    if (swapped) {
      // The registry's objects as one, without the dropped packs or the ones now listed.
      const gone = new Set([...drop, ...rewrite])
      await this.registry.replace(
        plan.registry,
        registered.filter((p) => !gone.has(p.id)),
      )
    }
    await this.#dropPlan(plan)
    await this.manifests.settle()
    return swapped ? { rewrite, stats } : null
  }

  async #dropPlan(plan: ReclaimPlan) {
    const keys = [reclaimKey(plan.id, 'plan')]
    for (let i = 0; i < plan.ranges.length; i++)
      keys.push(reclaimKey(plan.id, `range-${String(i).padStart(6, '0')}`))
    for (let i = 0; i < keys.length; i += 16)
      await Promise.all(keys.slice(i, i + 16).map((k) => this.store.delete(k)))
    // The claim last: a late caller finds it, or finds the range results gone.
    await this.store.delete(reclaimKey(plan.id, 'swap'))
  }

  /**
   * Step 4, a few packs a job: copy their live records into new packs and point
   * the index at them with a new, newest layer. A record is live when the index
   * still points at this copy of it.
   */
  async reclaimRewrite(packIds: readonly string[]): Promise<Record<string, number>> {
    const m = await this.manifests.latest()
    // Packs the manifest lists must still be there; the others (an older reclaim's) are in neither.
    const listed = new Set(m.packs.map((p) => p.id))
    const retired = new Set(m.retired.map((r) => r.key))
    const ids = packIds.filter((id) => !retired.has(packKey(id)))
    if (!ids.length) return {}
    const pw = new PackWriter(this.store, { tier: 0 })
    const lw = new RunWriter(this.store, 0)
    let kept = 0
    let dropped = 0
    // The packs' records in key order (each pack is sorted), so the new packs and
    // the layer pointing at them are written as they go. A record in two of them
    // comes twice; the index points at one copy, the one kept.
    const read = mergeRead(ids.length)
    let batch: { key: string; line: string; place: string }[] = []
    const flush = async () => {
      const found = await this.index.values(
        m,
        batch.map((b) => b.key),
      )
      for (const b of batch) {
        if (found.get(b.key) !== b.place) {
          dropped++
          continue
        }
        lw.add(b.key, pw.append(b.key, b.line))
        kept++
      }
      batch = []
      await Promise.all([pw.ready(), lw.ready()])
    }
    for await (const x of mergeAll(ids.map((id) => this.packs.all(id, read)))) {
      batch.push(x)
      if (batch.length === 1024) await flush()
    }
    await flush()
    const packs = await pw.finish()
    const files = await lw.finish()
    await this.#swap({
      oldPacks: ids.filter((id) => listed.has(id)),
      unlisted: ids.filter((id) => !listed.has(id)),
      newLayers: files,
      newPacks: packs,
    })
    await this.manifests.settle()
    return { packsRead: ids.length, recordsKept: kept, recordsDropped: dropped }
  }

  /**
   * A fork lists the parent's runs and packs as they are, and reads them where they
   * live; nothing is copied.
   */
  async forkInto(target: RecordStore): Promise<Record<string, number>> {
    if (!(target instanceof KeyedLayout)) throw new Error('forkInto: not a keyed layout')
    return this.#forkByReference(target)
  }

  async #forkByReference(target: KeyedLayout): Promise<Record<string, number>> {
    const from = this.store
    const to = target.store
    if (!(from instanceof HomeStore) || !(to instanceof HomeStore))
      throw new Error('forkInto: F needs both collections in their own prefixes')
    const m = await this.manifests.latest()
    const registered = (await this.#registered(m)).packs
    const levelPacks = await this.#levelPacks(m)
    // Each file's home: where the parent read it from (its own parent's), else the parent.
    const mine = await from.inherited()
    const inherited: Inherited = { packs: {}, layers: {} }
    for (const p of [...m.packs, ...registered, ...[...levelPacks.values()].flat()])
      inherited.packs[p.id] = mine.packs[p.id] ?? from.home
    for (const l of m.layers) inherited.layers[l.id] = mine.layers[l.id] ?? from.home
    const homes = new Set([...Object.values(inherited.packs), ...Object.values(inherited.layers)])
    // Every home first learns of the fork: from then on it keeps what the fork lists.
    for (const h of homes)
      await from.root.put(forkMarkerKey(h, to.home), JSON.stringify({ at: Date.now() }), {
        ifAbsent: true,
      })
    const body = JSON.stringify(inherited)
    await to.put(INHERITED_KEY, body)
    to.forget()
    await target.registry.add(registered)
    // A leveled parent's fork is leveled, its levels listing the parent's packs (in
    // shards of its own: they change as the fork's merges rewrite its levels).
    const levels: Record<string, LevelShard[]> = {}
    if (await this.leveled()) {
      await target.markLeveled()
      for (const [l, ps] of levelPacks) levels[l] = await target.levels.write(ps)
    }
    // The parent's layers keep their order but number below anything the fork writes.
    const top = Math.max(0, ...m.layers.map((l) => l.seq))
    await target.manifests.update((n) => {
      if (Object.keys(levels).length) n.levels = levels
      n.packs.push(...m.packs)
      n.layers.push(...m.layers.map((l) => ({ ...l, seq: l.seq - top - 1 })))
      return n
    })
    await target.manifests.settle()
    return { objects: 1 + homes.size, bytes: body.length }
  }

  /**
   * F: every file a copy of this collection needs, keyed from the location's root
   * (`runs/<collection>/…`, and for a fork the files it reads from its parent's
   * prefix, at their own keys), and the manifest to write with them (pending runs
   * folded in). A mirror copies these as they are: nothing is rebuilt.
   */
  async mirrorFiles(): Promise<{
    /** `optional`: a file older runs have and newer ones don't (a filter, now in the directory). */
    files: { key: string; bytes?: number; optional?: boolean }[]
    manifest: Manifest
    /** Where the copy's manifest goes: its own number, and the head. */
    manifestKeys: { numbered: string; head: string }
  }> {
    const home = this.store
    if (!(home instanceof HomeStore)) throw new Error('mirrorFiles: layout F only')
    const m = await this.manifests.latest()
    const registry = await this.#registered(m)
    const inh = await home.inherited()
    const at = (h: string | undefined, key: string) => `runs/${h ?? home.home}/${key}`
    const files: { key: string; bytes?: number; optional?: boolean }[] = []
    for (const l of m.layers) {
      const h = inh.layers[l.id]
      files.push(
        { key: at(h, layerKey(l.id)), bytes: l.bytes },
        { key: at(h, layerDirKey(l.id)) },
        { key: at(h, layerFilterKey(l.id)), optional: true },
      )
    }
    const levelPacks = [...(await this.#levelPacks(m)).values()].flat()
    for (const p of [...m.packs, ...levelPacks, ...registry.packs]) {
      const h = inh.packs[p.id]
      files.push({ key: at(h, packKey(p.id)), bytes: p.bytes }, { key: at(h, packDirKey(p.id)) })
    }
    for (const k of registry.keys) files.push({ key: at(undefined, k) })
    // A leveled collection's mark and its levels' shards: the copy's own, written once.
    for (const shards of Object.values(m.levels ?? {}))
      for (const s of shards) files.push({ key: at(undefined, shardKey(s.id)) })
    if (await this.leveled()) files.push({ key: at(undefined, LEVELED_KEY) })
    if (Object.keys(inh.packs).length || Object.keys(inh.layers).length)
      files.push({ key: at(undefined, 'inherited.json') })
    const dir = `runs/${home.home}/manifest/${this.name}`
    return {
      files,
      manifest: { ...m, retired: [], folded: [] },
      manifestKeys: {
        numbered: `${dir}/${String(m.seq).padStart(12, '0')}.json`,
        head: `${dir}/head.json`,
      },
    }
  }

  /**
   * F: of the files a mirror copied that `mirrorFiles` no longer lists, which it may
   * delete (`drop`) and which to forget without deleting (`forget`). Another
   * collection's (a fork's parent's, at its own keys) are forgotten: that collection
   * may be mirrored at the same location. This set's own stay while a live fork reads
   * them, as here: that fork's mirror there may list them. The rest are dropped.
   */
  async mirrorDroppable(keys: readonly string[]): Promise<{ drop: string[]; forget: string[] }> {
    const home = this.store
    if (!(home instanceof HomeStore)) throw new Error('mirrorDroppable: layout F only')
    const own = `runs/${home.home}/`
    const held = keys.some((k) => k.startsWith(own)) ? await home.forkHeld() : new Set<string>()
    const drop: string[] = []
    const forget: string[] = []
    for (const k of keys)
      if (!k.startsWith(own)) forget.push(k)
      else if (!held.has(fileId(k.slice(own.length)) ?? '')) drop.push(k)
    return { drop, forget }
  }

  /**
   * F: delete what a deleted collection wrote, but for files a live fork still
   * reads (they go when that fork does); then the same for each collection it
   * read from that is gone too, whose forks now hold less.
   */
  static async dropCollection(
    root: Store,
    id: string,
    deleted: (collectionId: string) => Promise<boolean>,
  ): Promise<{ objects: number; kept: number }> {
    const home = new HomeStore(root, id)
    const mine = await home.inherited()
    const homes = new Set([...Object.values(mine.packs), ...Object.values(mine.layers)])
    for (const h of homes) await root.delete(forkMarkerKey(h, id))
    const held = await home.forkHeld()
    let objects = 0
    let kept = 0
    let cursor: string | undefined
    do {
      const page = await root.list(`runs/${id}/`, cursor)
      const drop = page.keys.filter((k) => {
        const rel = k.slice(`runs/${id}/`.length)
        // A fork's marker stays while that fork lives; so does what it reads.
        const keep = rel.startsWith('forks/') || held.has(fileId(rel) ?? '')
        if (keep) kept++
        return !keep
      })
      for (let i = 0; i < drop.length; i += 16)
        await Promise.all(drop.slice(i, i + 16).map((k) => root.delete(k)))
      objects += drop.length
      cursor = page.cursor
    } while (cursor)
    for (const h of homes)
      if (await deleted(h)) {
        const r = await KeyedLayout.dropCollection(root, h, deleted)
        objects += r.objects
        kept += r.kept
      }
    return { objects, kept }
  }
}

/** Pack records from several sorted streams, in key order, every one kept (mergeSorted keeps one a key). */
async function* mergeAll<T extends { key: string }>(
  streams: AsyncIterable<T>[],
): AsyncGenerator<T> {
  const its = streams.map((s) => s[Symbol.asyncIterator]())
  const heads = await Promise.all(its.map((it) => it.next()))
  for (;;) {
    let best = -1
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i]!
      if (h.done) continue
      if (best < 0 || compareUtf8(h.value.key, (heads[best]!.value as T).key) < 0) best = i
    }
    if (best < 0) return
    yield heads[best]!.value as T
    heads[best] = await its[best]!.next()
  }
}

/** F: the files a fork read from other collections at fork time, by id: where each lives. */
export interface Inherited {
  packs: Record<string, string>
  layers: Record<string, string>
}

const INHERITED_KEY = 'inherited.json'
const forkMarkerKey = (home: string, fork: string) => `runs/${home}/forks/${fork}.json`

/** The id a pack or index file's key names (`packs/<id>.pk`, `layers/<id>.bf`, …), else null. */
function fileId(key: string): string | null {
  const m = /^(?:packs|layers)\/([^./]+)\./.exec(key)
  return m ? m[1]! : null
}

/**
 * F: a collection's own prefix, through which it also reads the files it
 * inherited from the collections they live with (a fork's parent, or further
 * back). Writes and deletes only ever touch its own prefix: a fork can't delete
 * what its parent still uses.
 */
export class HomeStore extends PrefixedStore {
  #inherited: { v: Promise<Inherited>; at: number } | null = null

  constructor(
    readonly root: Store,
    readonly home: string,
  ) {
    super(root, `runs/${home}`)
  }

  /** The files this collection inherited (read once; again after a miss, at most every 2 s). */
  inherited(): Promise<Inherited> {
    if (!this.#inherited) {
      const v = super
        .get(INHERITED_KEY)
        .then(async (o) =>
          o ? (JSON.parse(await o.text()) as Inherited) : { packs: {}, layers: {} },
        )
      this.#inherited = { v, at: Date.now() }
    }
    return this.#inherited.v
  }

  /** Read the inherited files again (a fork just made, in this isolate). */
  forget(): void {
    this.#inherited = null
  }

  /** Every file of this collection a live fork reads (a fork's listing names its home). */
  async forkHeld(): Promise<Set<string>> {
    const held = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await super.list('forks/', cursor)
      for (const k of page.keys) {
        const fork = k.slice('forks/'.length, -'.json'.length)
        const o = await this.root.get(`runs/${fork}/${INHERITED_KEY}`)
        if (!o) continue
        const inh = JSON.parse(await o.text()) as Inherited
        for (const [id, h] of [...Object.entries(inh.packs), ...Object.entries(inh.layers)])
          if (h === this.home) held.add(id)
      }
      cursor = page.cursor
    } while (cursor)
    return held
  }

  async #owner(key: string): Promise<string | null> {
    const id = fileId(key)
    if (!id) return null
    const inh = await this.inherited()
    return inh.packs[id] ?? inh.layers[id] ?? null
  }

  override async get(key: string, range?: { offset: number; length?: number }) {
    const owner = await this.#owner(key)
    if (owner) return this.root.get(`runs/${owner}/${key}`, range)
    const o = await super.get(key, range)
    // Not here and not known as inherited: a fork made after this isolate read its list.
    if (!o && fileId(key) && this.#inherited && Date.now() - this.#inherited.at > 2000) {
      this.forget()
      const again = await this.#owner(key)
      if (again) return this.root.get(`runs/${again}/${key}`, range)
    }
    return o
  }

  override async head(key: string) {
    const owner = await this.#owner(key)
    return owner ? this.root.head(`runs/${owner}/${key}`) : super.head(key)
  }

  override async delete(key: string) {
    // Another collection's file: never deleted from here.
    if (await this.#owner(key)) return
    return super.delete(key)
  }
}

class KeyedWriter implements RecordWriter {
  #packs: PackWriter
  #entries: [string, string][] = []
  /** Runs written and held back from the manifest (`hold`), in order. */
  readonly #held: PendingRun[] = []

  constructor(
    readonly layout: KeyedLayout,
    readonly opts: { hold?: boolean } = {},
  ) {
    this.#packs = new PackWriter(layout.store)
  }

  add(type: string, entry: RecordEntry, line: string): string {
    const k = recordKey(type, entry.key, entry.hash)
    const at = this.#packs.append(k, line)
    this.#entries.push([k, at])
    return at
  }

  addPlaced(type: string, entry: RecordEntry, place: string): string {
    // Counted with `add`'s entries: `drain` writes a run out at `writerRunEntries` either way.
    this.#entries.push([recordKey(type, entry.key, entry.hash), place])
    return place
  }

  /**
   * Write a run out once `writerRunEntries` index entries are held: a commit's
   * entries held to its end grew with the push (204k records, a 128 MB isolate
   * out of memory on staging, 2026-10-20).
   */
  async drain(): Promise<void> {
    // Packs write as they fill: without waiting, large records piled up compressing.
    await this.#packs.ready()
    if (this.#entries.length >= layoutConfig.writerRunEntries) await this.#run()
  }

  async finish(): Promise<PendingRun[]> {
    await this.#run()
    return this.#held.splice(0)
  }

  /** The entries held as an index run, with the packs they're in (closed: a run stands alone). */
  async #run(): Promise<void> {
    const packs = await this.#packs.finish()
    this.#packs = new PackWriter(this.layout.store)
    if (!this.#entries.length) return
    this.#entries.sort((a, b) => compareUtf8(a[0], b[0]))
    const lw = new RunWriter(this.layout.store, 0)
    for (const [k, v] of this.#entries) lw.add(k, v)
    this.#entries = []
    const files = await lw.finish()
    // Listed before the manifest names their index: a pack the manifest never got
    // (a failed update) is one reclaim finds with nothing live, and drops. A leveled
    // collection's go to level 0, every one: merges take them down.
    const leveled = await this.layout.leveled()
    const final = (p: PackInfo) => !leveled && KeyedLayout.final(p)
    await this.layout.registry.add(packs.filter(final))
    const run = { layers: files, packs: packs.filter((p) => !final(p)) }
    // Held: the caller names them later, with the rest of its commit (appendRuns).
    if (this.opts.hold) this.#held.push(run)
    else await this.layout.manifests.append(run.layers, run.packs)
    // Merges run after the commit, as their own job (the server's layout.maintain).
  }
}
