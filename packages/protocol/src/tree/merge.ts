/**
 * Incremental merge: apply a sorted stream of changes to a base tree.
 *
 * Walk the base tree top-down. A base node with no change in its key range is
 * reused whole when the builder is sitting on a boundary at its level (see
 * TreeBuilder.addNode); otherwise it is expanded, and at a leaf the base entries
 * are merged with the changes and fed to the builder entry by entry. A change
 * belongs to the first node whose last key is ≥ the change's key; changes past
 * the base's last key are appended at the end.
 *
 * Work is O(changes × fanout × height): each change expands one path, plus at
 * most one neighbour per level to re-align with the base's boundaries. The result
 * is identical to building the new entry set from scratch, which the property
 * tests check.
 *
 * Range mode (`range` plus `leafOutput`) is one commit unit of a parallel commit:
 * it merges only the base entries and changes in `(after, through]` and outputs
 * that range's leaves, building no interior node. When both ends are natural
 * leaf boundaries present in the new entry set (or null), those leaves are
 * exactly the full result's leaves for the range, because a leaf always ends
 * after a natural boundary. `assembleTree` builds the levels above.
 */
import { compareUtf8 } from '../utf8.js'
import { type BuilderOptions, TreeBuilder, type TreeSink } from './builder.js'
import type { NodeDesc } from './node.js'
import { type NodeSource, resolveRoot, rootDesc } from './source.js'

/** Upsert (`entry`) or delete (`entry: null`) of one key. */
export interface Change<E> {
  key: string
  entry: E | null
}

export interface MergeStats {
  added: number
  removed: number
  updated: number
  /** Upserts identical to the base entry. */
  unchanged: number
  /** Deletes of keys the base doesn't have. */
  missingDeletes: number
  /** Base nodes reused without being read. */
  reusedNodes: number
  /** Base nodes read (expanded or rewritten). */
  readNodes: number
}

/** A key range `(after, through]`; null is unbounded on that side. */
export interface KeyRange {
  after: string | null
  through: string | null
}

export interface MergeOptions<E> extends BuilderOptions<E> {
  /** Called for every effective change, in key order: (old, new). */
  onChange?: (before: E | null, after: E | null) => void
  /**
   * Merge only this range (a commit unit). Requires `leafOutput`, and every
   * change must lie in the range.
   */
  range?: KeyRange
}

export interface MergeResult {
  /** Null for an empty tree, and always null in range mode. */
  root: NodeDesc | null
  stats: MergeStats
  /**
   * Range mode only: the last key output, or null if the range came out empty.
   * The unit's leaves are valid only if this is `range.through` (or `through`
   * is null); otherwise `through` was deleted and the caller merges this unit
   * with the next one.
   */
  lastKey?: string | null
}

/** Is `key` inside `(after, through]`? */
export function inRange(range: KeyRange, key: string): boolean {
  return (
    (range.after === null || compareUtf8(key, range.after) > 0) &&
    (range.through === null || compareUtf8(key, range.through) <= 0)
  )
}

export function emptyStats(): MergeStats {
  return {
    added: 0,
    removed: 0,
    updated: 0,
    unchanged: 0,
    missingDeletes: 0,
    reusedNodes: 0,
    readNodes: 0,
  }
}

export class Peekable<T> {
  readonly #it: Iterator<T> | AsyncIterator<T>
  #head: IteratorResult<T> | undefined

  constructor(src: Iterable<T> | AsyncIterable<T>) {
    this.#it =
      Symbol.asyncIterator in src
        ? (src as AsyncIterable<T>)[Symbol.asyncIterator]()
        : (src as Iterable<T>)[Symbol.iterator]()
  }

  async peek(): Promise<T | undefined> {
    this.#head ??= await this.#it.next()
    return this.#head.done ? undefined : this.#head.value
  }

  async next(): Promise<T | undefined> {
    const v = await this.peek()
    this.#head = undefined
    return v
  }
}

export async function mergeTree<E>(
  source: NodeSource<E>,
  sink: TreeSink<E>,
  base: string | null,
  changes: Iterable<Change<E>> | AsyncIterable<Change<E>>,
  opts: MergeOptions<E> = {},
): Promise<MergeResult> {
  const spec = source.spec
  const range = opts.range
  if (range && !opts.leafOutput) throw new Error('mergeTree: range mode needs leafOutput')
  const builder = new TreeBuilder(spec, sink, opts)
  const pending = new Peekable(changes)
  const stats = emptyStats()
  let prevChangeKey: string | null = null

  const nextChange = async (): Promise<Change<E> | undefined> => {
    const c = await pending.next()
    if (c) {
      if (prevChangeKey !== null && compareUtf8(prevChangeKey, c.key) >= 0) {
        throw new Error(`mergeTree: changes out of order at ${JSON.stringify(c.key)}`)
      }
      if (c.entry && spec.key(c.entry) !== c.key) {
        throw new Error('mergeTree: change key does not match its entry')
      }
      if (range && !inRange(range, c.key)) {
        throw new Error(`mergeTree: change ${JSON.stringify(c.key)} is outside the unit's range`)
      }
      prevChangeKey = c.key
    }
    return c
  }

  /** Apply one change that has no base entry. */
  const insert = (c: Change<E>) => {
    if (c.entry) {
      stats.added++
      opts.onChange?.(null, c.entry)
      builder.addEntry(c.entry)
    } else {
      stats.missingDeletes++
    }
  }

  const rewriteLeaf = async (desc: NodeDesc) => {
    stats.readNodes++
    const entries = await source.leafEntries(desc.hash)
    for (const old of entries) {
      const oldKey = spec.key(old)
      // A leaf straddling a unit's range edge: keep only the range's entries.
      if (range && !inRange(range, oldKey)) continue
      // Changes before this entry are inserts (or deletes of absent keys).
      for (;;) {
        const c = await pending.peek()
        if (!c || compareUtf8(c.key, oldKey) >= 0) break
        insert((await nextChange())!)
        // A run of inserts inside one base leaf's range can be arbitrarily long.
        if (stats.added % 1024 === 0) await sink.drain?.()
      }
      const c = await pending.peek()
      if (c && c.key === oldKey) {
        await nextChange()
        if (!c.entry) {
          stats.removed++
          opts.onChange?.(old, null)
        } else if (spec.same(old, c.entry)) {
          stats.unchanged++
          builder.addEntry(old)
        } else {
          stats.updated++
          opts.onChange?.(old, c.entry)
          builder.addEntry(c.entry)
        }
      } else {
        builder.addEntry(old)
      }
    }
    // Changes between this leaf's last entry and its last key can't exist (the
    // last entry is the last key), so nothing else belongs to this leaf.
  }

  // `rightEdge`: the node is the last of its level in the base. It may have ended
  // because the tree ended rather than at a boundary, so it can only be reused
  // when nothing is appended after it, i.e. no change remains at all.
  // `low`: the node's exclusive lower bound (the previous sibling's last key, or
  // null at the left edge), needed to place the node against a unit's range.
  const visit = async (desc: NodeDesc, rightEdge: boolean, low: string | null): Promise<void> => {
    let inside = true
    if (range) {
      // Entirely before or after the range: not part of this unit.
      if (range.after !== null && compareUtf8(desc.lastKey, range.after) <= 0) return
      if (range.through !== null && low !== null && compareUtf8(low, range.through) >= 0) return
      // Only nodes wholly inside the range may be reused, and only leaves, since
      // a unit builds no interior nodes.
      inside =
        desc.level === 0 &&
        (range.after === null || (low !== null && compareUtf8(low, range.after) >= 0)) &&
        (range.through === null || compareUtf8(desc.lastKey, range.through) <= 0)
    }
    const c = await pending.peek()
    const changed = c !== undefined && (rightEdge || compareUtf8(c.key, desc.lastKey) <= 0)
    if (inside && !changed && builder.emptyThrough(desc.level)) {
      stats.reusedNodes++
      builder.addNode(desc)
      return
    }
    if (desc.level === 0) {
      await rewriteLeaf(desc)
      await sink.drain?.()
      return
    }
    stats.readNodes++
    const node = await source.node(desc.hash)
    if (node.kind !== 'node' || node.level !== desc.level) {
      throw new Error(`mergeTree: node ${desc.hash} is not at level ${desc.level}`)
    }
    const last = node.children.length - 1
    for (let i = 0; i <= last; i++) {
      await visit(
        node.children[i]!,
        rightEdge && i === last,
        i === 0 ? low : node.children[i - 1]!.lastKey,
      )
    }
  }

  if (base !== null) {
    if (!range && (await pending.peek()) === undefined) {
      // Nothing to apply: the base is the result.
      return { root: await rootDesc(source, base), stats }
    }
    stats.readNodes++
    await visit(await rootDesc(source, base), true, null)
  }
  let appended = 0
  for (let c = await nextChange(); c; c = await nextChange()) {
    insert(c)
    if (++appended % 1024 === 0) await sink.drain?.()
  }

  const { root, unresolved } = builder.finish()
  if (range) return { root: null, stats, lastKey: builder.lastKey }
  return { root: root && unresolved ? await resolveRoot(source, root) : root, stats }
}
