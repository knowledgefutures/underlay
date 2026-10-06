/**
 * Assembly: the second half of a parallel commit.
 *
 * Commit units (`mergeTree` in range mode) each output the new leaves of one key
 * range. `assembleTree` walks the base tree like `mergeTree` and, where the
 * serial merge would rewrite leaves, inserts the units' leaves with `addNode`
 * instead. That is valid because a segment starts and ends at natural leaf
 * boundaries, so the builder's leaf level is empty at both ends. Base subtrees
 * between segments are reused whole, as in `mergeTree`; the result is the tree
 * the serial merge would have built, byte for byte.
 *
 * What makes a list of segments valid (the planner keeps these):
 * - segments are sorted and disjoint, and every change lies in one;
 * - each non-null `after`/`through` is a natural leaf boundary present in the
 *   new entry set;
 * - an `after` that isn't a base key is the `through` of the previous segment;
 * - a gap between segments holds no changes.
 *
 * So the only base leaves that straddle a segment edge are ones holding an
 * unchanged `after` (whose head is copied before the segment) or a `through`
 * that was inserted (whose tail is re-chunked after it). Assembly reads at most
 * a leaf or two per segment, plus the interior path down to them.
 */
import { compareUtf8 } from '../utf8.js'
import { type BuilderOptions, TreeBuilder, type TreeSink } from './builder.js'
import { emptyStats, type KeyRange, type MergeResult } from './merge.js'
import type { NodeDesc } from './node.js'
import { type NodeSource, resolveRoot, rootDesc } from './source.js'

/**
 * One unit's output: its range and the leaves it produced, in key order. The
 * leaves can be a loader, called once when assembly reaches the segment, so a
 * large commit never holds every unit's leaves at once.
 */
export interface Segment extends KeyRange {
  leaves: readonly NodeDesc[] | (() => Promise<readonly NodeDesc[]>)
}

/** Build the new tree from the base and the units' segments. */
export async function assembleTree<E>(
  source: NodeSource<E>,
  sink: TreeSink<E>,
  base: string | null,
  segments: readonly Segment[],
  opts: Omit<BuilderOptions<E>, 'leafOutput'> = {},
): Promise<MergeResult> {
  const spec = source.spec
  const stats = emptyStats()
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!.through
    const after = segments[i]!.after
    if (prev === null || after === null || compareUtf8(prev, after) > 0) {
      throw new Error('assembleTree: segments must be sorted and disjoint')
    }
  }
  if (segments.length === 0)
    return { root: base === null ? null : await rootDesc(source, base), stats }

  const builder = new TreeBuilder(spec, sink, opts)
  let head = 0
  // Everything up to `covered` is in the output; `all` once a segment ran to the end.
  let covered: string | null = null
  let all = false
  const isCovered = (key: string) => all || (covered !== null && compareUtf8(key, covered) <= 0)

  const emit = async (seg: Segment) => {
    const leaves = typeof seg.leaves === 'function' ? await seg.leaves() : seg.leaves
    for (const leaf of leaves) builder.addNode(leaf)
    if (seg.through === null) all = true
    else covered = seg.through
    head++
  }
  /** Does the head segment start before `lastKey`, i.e. touch a node ending there? */
  const overlaps = (lastKey: string) => {
    const seg = segments[head]
    return seg !== undefined && (seg.after === null || compareUtf8(lastKey, seg.after) > 0)
  }

  const visit = async (desc: NodeDesc, rightEdge: boolean, low: string | null): Promise<void> => {
    if (isCovered(desc.lastKey)) return
    // Reusable when no segment touches it, no part of it is already covered (a
    // base leaf can straddle an inserted `through`), the builder sits on a
    // boundary at its level, and it isn't a right-edge node that segments will
    // be appended after.
    const whole = covered === null || (low !== null && compareUtf8(low, covered) >= 0)
    if (
      !overlaps(desc.lastKey) &&
      whole &&
      builder.emptyThrough(desc.level) &&
      !(rightEdge && head < segments.length)
    ) {
      stats.reusedNodes++
      builder.addNode(desc)
      return
    }
    stats.readNodes++
    if (desc.level === 0) {
      const entries = await source.leafEntries(desc.hash)
      let i = 0
      while (overlaps(desc.lastKey)) {
        const seg = segments[head]!
        // Under the rules a segment never starts inside a base leaf with
        // uncovered entries before it: an unchanged `after` ends its base leaf,
        // and an inserted one was covered by the previous segment.
        if (seg.after !== null) {
          for (; i < entries.length && compareUtf8(spec.key(entries[i]!), seg.after) <= 0; i++) {
            if (!isCovered(spec.key(entries[i]!))) {
              throw new Error(
                `assembleTree: segment after ${JSON.stringify(seg.after)} starts inside a base leaf`,
              )
            }
          }
        }
        await emit(seg)
        if (all) return
      }
      // The tail of a base leaf straddling an inserted `through`.
      for (const e of entries) if (!isCovered(spec.key(e))) builder.addEntry(e)
      await sink.drain?.()
      return
    }
    const node = await source.node(desc.hash)
    if (node.kind !== 'node' || node.level !== desc.level) {
      throw new Error(`assembleTree: node ${desc.hash} is not at level ${desc.level}`)
    }
    const last = node.children.length - 1
    for (let i = 0; i <= last && !all; i++) {
      await visit(
        node.children[i]!,
        rightEdge && i === last,
        i === 0 ? low : node.children[i - 1]!.lastKey,
      )
    }
  }

  if (base !== null) {
    stats.readNodes++
    await visit(await rootDesc(source, base), true, null)
  }
  while (head < segments.length) await emit(segments[head]!)

  const { root, unresolved } = builder.finish()
  return { root: root && unresolved ? await resolveRoot(source, root) : root, stats }
}
