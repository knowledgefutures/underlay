/**
 * A leveled collection's levels (leveled-packs-design.md): below level 0 (the packs
 * commits and uploads write, listed in the manifest as ever), levels 1…MAX_LEVEL
 * each hold packs that never overlap, in key order, within one type. The bottom
 * level holds most of the collection; each level above is 1/T the size of the one
 * below, so a record is rewritten about T times a level on its way down, and a leaf
 * of the current version reads about one pack a level, however many days of
 * changes went in (Crossref's dailies over three years, simulated: 28 GETs a leaf
 * at the median where tiered packs took 255).
 *
 * A level's packs are listed in shards: write-once objects of up to `shardPacks`
 * packs each, in key order, which the manifest names with their key ranges. The
 * bottom level of a Crossref-sized collection is tens of thousands of packs, too
 * many for the manifest every reader reads; a merge rewrites only the shards its
 * key range touches. Readers never read them: records are found through the index.
 */
import { compareUtf8 } from '../../utf8.js'
import type { Store } from '../types.js'
import { newId, PACK_RAW, type PackInfo } from './kit.js'

/** Levels below level 0. The bottom one holds most of a collection (RocksDB's seven, 0–6). */
export const MAX_LEVEL = 6
/** Each level's size against the one below it. */
export const LEVEL_RATIO = 10

/** Sizes (tests set them low). */
export const levelConfig = {
  /**
   * The smallest a level's target gets: level 0 merges into the highest level whose
   * target is at least this, skipping smaller ones (RocksDB's dynamic level sizes).
   * About half a day of Crossref's changes: three levels above a 1 TB bottom.
   */
  minRaw: 256 * 1024 * 1024,
  /**
   * Level 0 merges down once it holds this many packs, or `level0Raw` raw bytes (or a
   * tenth of the level it merges into, if more). A leaf's recent changes are in level
   * 0's packs, one read each, so their number is a read cost.
   */
  level0Packs: 16,
  level0Raw: 64 * 1024 * 1024,
  /** Raw bytes of level-0 packs one merge takes, oldest first. */
  level0MergeRaw: 256 * 1024 * 1024,
  /** Raw bytes a merge's packs close at. */
  packRaw: PACK_RAW,
  /** Packs a shard lists at most. */
  shardPacks: 512,
}

/** A shard of a level's listing, as the manifest names it. */
export interface LevelShard {
  id: string
  lo: string
  hi: string
  packs: number
  /** Raw and stored bytes of its packs. */
  raw: number
  bytes: number
}

export type Levels = Record<string, LevelShard[]>

export const shardKey = (id: string) => `manifest/f/levels/${id}.json`

/** Whether [aLo, aHi] and [bLo, bHi] share a key. */
export const overlaps = (aLo: string, aHi: string, bLo: string, bHi: string) =>
  compareUtf8(aLo, bHi) <= 0 && compareUtf8(bLo, aHi) <= 0

const byLo = (a: PackInfo, b: PackInfo) => compareUtf8(a.lo!, b.lo!)

/** Raw bytes a level holds. */
export const levelRaw = (levels: Levels | undefined, level: number) =>
  (levels?.[level] ?? []).reduce((n, s) => n + s.raw, 0)

/**
 * Each level's target size from the bottom up, and the base level, where level 0
 * merges: the highest whose target is at least `levelConfig.minRaw`, and never the bottom,
 * so level 0 never rewrites the whole collection (the level above it takes level
 * 0's merges and goes down a pack at a time). Levels above the base have no room
 * (target 0).
 */
export function levelTargets(levels: Levels | undefined): { base: number; targets: number[] } {
  const targets = Array.from<number>({ length: MAX_LEVEL + 1 }).fill(0)
  let t = levelRaw(levels, MAX_LEVEL)
  targets[MAX_LEVEL] = Infinity
  let base = MAX_LEVEL - 1
  targets[base] = t / LEVEL_RATIO
  t /= LEVEL_RATIO
  for (let l = MAX_LEVEL - 2; l >= 1; l--) {
    t /= LEVEL_RATIO
    if (t < levelConfig.minRaw) break
    targets[l] = t
    base = l
  }
  return { base, targets }
}

/** The shards a leveled collection's levels are listed in (each read once: they never change). */
export class LevelShards {
  readonly #read = new Map<string, Promise<PackInfo[]>>()

  constructor(readonly store: Store) {}

  read(id: string): Promise<PackInfo[]> {
    let p = this.#read.get(id)
    if (!p) {
      p = this.store.get(shardKey(id)).then(async (o) => {
        if (!o) throw new Error(`Missing level shard ${id}`)
        return JSON.parse(await o.text()) as PackInfo[]
      })
      p.catch(() => this.#read.delete(id))
      this.#read.set(id, p)
    }
    return p
  }

  /** Every pack of `shards`, in key order. */
  async packs(shards: readonly LevelShard[]): Promise<PackInfo[]> {
    const out: PackInfo[] = []
    for (let i = 0; i < shards.length; i += 16)
      for (const ps of await Promise.all(shards.slice(i, i + 16).map((s) => this.read(s.id))))
        out.push(...ps)
    return out
  }

  /** The packs of `shards` that hold a key in [lo, hi], in key order. */
  async overlapping(shards: readonly LevelShard[], lo: string, hi: string): Promise<PackInfo[]> {
    const touched = shards.filter((s) => overlaps(s.lo, s.hi, lo, hi))
    return (await this.packs(touched)).filter((p) => overlaps(p.lo!, p.hi!, lo, hi))
  }

  /** `packs` (in key order, none overlapping) as new shards, written. */
  async write(packs: readonly PackInfo[]): Promise<LevelShard[]> {
    const out: LevelShard[] = []
    for (let i = 0; i < packs.length; i += levelConfig.shardPacks) {
      const ps = packs.slice(i, i + levelConfig.shardPacks)
      const id = newId()
      this.#read.set(id, Promise.resolve(ps))
      await this.store.put(shardKey(id), JSON.stringify(ps), { ifAbsent: true })
      out.push({
        id,
        lo: ps[0]!.lo!,
        hi: ps.at(-1)!.hi!,
        packs: ps.length,
        raw: ps.reduce((n, p) => n + p.raw, 0),
        bytes: ps.reduce((n, p) => n + p.bytes, 0),
      })
    }
    return out
  }

  /**
   * A level's shards with the packs `remove` gone and `add` in. Only the shards
   * holding a removed pack, or whose range the added ones fall in or between, are
   * written again: the result, the shards written, and the ones they replace.
   * Throws if the level would overlap.
   */
  async replace(
    shards: readonly LevelShard[],
    remove: ReadonlySet<string>,
    add: readonly PackInfo[],
  ): Promise<{ shards: LevelShard[]; written: string[]; replaced: string[] }> {
    const added = [...add].sort(byLo)
    // Shards touched: those holding a removed pack (found by reading the ones whose
    // range could), and those the added packs' range reaches.
    const touched = new Set<number>()
    for (let i = 0; i < shards.length; i++) {
      const s = shards[i]!
      if (added.length && overlaps(s.lo, s.hi, added[0]!.lo!, added.at(-1)!.hi!)) touched.add(i)
    }
    if (remove.size)
      for (let i = 0; i < shards.length; i++) {
        if (touched.has(i)) continue
        const ps = await this.read(shards[i]!.id)
        if (ps.some((p) => remove.has(p.id))) touched.add(i)
      }
    // Added packs that fall between shards: the shards on either side join, so the
    // rewritten stretch stays contiguous.
    if (added.length && !touched.size) {
      const at = shards.findIndex((s) => compareUtf8(s.lo, added[0]!.lo!) > 0)
      if (at > 0) touched.add(at - 1)
      else if (at === 0) touched.add(0)
      else if (shards.length) touched.add(shards.length - 1)
    }
    if (!touched.size && !added.length) return { shards: [...shards], written: [], replaced: [] }
    const idx = [...touched].sort((a, b) => a - b)
    const from = idx[0] ?? shards.length
    const to = idx.length ? idx.at(-1)! : shards.length - 1
    const kept = (await this.packs(shards.slice(from, to + 1))).filter((p) => !remove.has(p.id))
    const packs = [...kept, ...added].sort(byLo)
    for (let i = 1; i < packs.length; i++)
      if (compareUtf8(packs[i]!.lo!, packs[i - 1]!.hi!) <= 0)
        throw new Error(`Level overlap: pack ${packs[i]!.id} starts inside ${packs[i - 1]!.id}`)
    const fresh = await this.write(packs)
    const before = shards.slice(0, from)
    const after = shards.slice(to + 1)
    if (before.length && fresh.length && compareUtf8(fresh[0]!.lo, before.at(-1)!.hi) <= 0)
      throw new Error('Level overlap at a shard boundary')
    if (after.length && fresh.length && compareUtf8(fresh.at(-1)!.hi, after[0]!.lo) >= 0)
      throw new Error('Level overlap at a shard boundary')
    return {
      shards: [...before, ...fresh, ...after],
      written: fresh.map((s) => s.id),
      replaced: shards.slice(from, to + 1).map((s) => s.id),
    }
  }
}
