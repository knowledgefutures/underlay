/**
 * Reading trees: point lookups, ordered iteration from a key or an offset, and
 * diff. Interior entries carry each child's last key and entry count, so a seek by
 * key or by offset reads one node per level.
 */
import { compareUtf8 } from '../utf8.js'
import type { NodeDesc } from './node.js'
import { type NodeSource, rootDesc } from './source.js'

/** Look up one key. One node read per level. */
export async function getEntry<E>(
  source: NodeSource<E>,
  root: string | null,
  key: string,
): Promise<E | null> {
  if (root === null) return null
  let hash = root
  for (;;) {
    const node = await source.node(hash)
    if (node.kind === 'leaf') {
      return node.entries.find((e) => source.spec.key(e) === key) ?? null
    }
    const child = node.children.find((c) => compareUtf8(key, c.lastKey) <= 0)
    if (!child) return null
    hash = child.hash
  }
}

/**
 * The number of entries with keys less than `key` (its rank). One node read per
 * level, using the counts in interior entries.
 */
export async function rankOf<E>(
  source: NodeSource<E>,
  root: string | null,
  key: string,
): Promise<number> {
  if (root === null) return 0
  let rank = 0
  let hash = root
  for (;;) {
    const node = await source.node(hash)
    if (node.kind === 'leaf') {
      for (const e of node.entries) {
        if (compareUtf8(source.spec.key(e), key) >= 0) break
        rank++
      }
      return rank
    }
    let next: string | null = null
    for (const c of node.children) {
      if (compareUtf8(key, c.lastKey) <= 0) {
        next = c.hash
        break
      }
      rank += c.count
    }
    if (next === null) return rank
    hash = next
  }
}

/** The entry at a position (0-based), or null past the end. One node read per level. */
export async function entryAt<E>(
  source: NodeSource<E>,
  root: string | null,
  index: number,
): Promise<E | null> {
  if (root === null || index < 0) return null
  let hash = root
  let i = index
  for (;;) {
    const node = await source.node(hash)
    if (node.kind === 'leaf') return node.entries[i] ?? null
    let next: string | null = null
    for (const c of node.children) {
      if (i < c.count) {
        next = c.hash
        break
      }
      i -= c.count
    }
    if (next === null) return null
    hash = next
  }
}

export interface IterateOptions {
  /** Start after this key (keyset pagination). Exclusive with `offset`. */
  after?: string
  /** Skip this many entries first (offset pagination; O(height) via counts). Exclusive with `after`. */
  offset?: number
  /** Leaves to fetch ahead in parallel. Default 4. */
  prefetch?: number
  /** Read leaves with payloads (record bodies) through `leafEntries`. */
  payloads?: boolean
}

/**
 * The leaves covering a seek, in order: yields each leaf's descriptor and how
 * many of its entries to skip. Interior nodes are read on demand, one path at a
 * time.
 */
async function* leavesFrom<E>(
  source: NodeSource<E>,
  root: NodeDesc,
  after: string | undefined,
  offset: number,
): AsyncGenerator<{ leaf: NodeDesc; skip: number; after: string | undefined }> {
  // Stack of (children, next index) frames, rooted at the root.
  type Frame = { children: NodeDesc[]; i: number }
  const stack: Frame[] = [{ children: [root], i: 0 }]
  let first = true
  let remaining = offset
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    if (top.i >= top.children.length) {
      stack.pop()
      continue
    }
    const d = top.children[top.i++]!
    if (first) {
      // Still seeking: skip whole subtrees before the start position.
      if (after !== undefined && compareUtf8(d.lastKey, after) <= 0) continue
      if (remaining >= d.count) {
        remaining -= d.count
        continue
      }
    }
    if (d.level === 0) {
      yield { leaf: d, skip: first ? remaining : 0, after: first ? after : undefined }
      first = false
      continue
    }
    const node = await source.node(d.hash)
    if (node.kind !== 'node') throw new Error(`Expected interior node at ${d.hash}`)
    stack.push({ children: node.children, i: 0 })
  }
}

/** Every leaf of a tree, in key order (interior nodes read one path at a time). */
export async function* leaves<E>(
  source: NodeSource<E>,
  root: string | null,
): AsyncGenerator<NodeDesc> {
  if (root === null) return
  for await (const { leaf } of leavesFrom(source, await rootDesc(source, root), undefined, 0))
    yield leaf
}

/** Iterate entries in key order from a position, prefetching leaves ahead. */
export async function* iterate<E>(
  source: NodeSource<E>,
  root: string | null,
  opts: IterateOptions = {},
): AsyncGenerator<E> {
  if (root === null) return
  if (opts.after !== undefined && opts.offset)
    throw new Error('iterate: pass after or offset, not both')
  const spec = source.spec
  const load = (h: string) =>
    opts.payloads
      ? source.leafEntries(h)
      : source.node(h).then((n) => (n.kind === 'leaf' ? n.entries : []))
  const ahead = Math.max(1, opts.prefetch ?? 4)
  const queue: { entries: Promise<E[]>; skip: number; after: string | undefined }[] = []
  const leaves = leavesFrom(source, await rootDesc(source, root), opts.after, opts.offset ?? 0)
  let exhausted = false
  const fill = async () => {
    while (!exhausted && queue.length < ahead) {
      const r = await leaves.next()
      if (r.done) {
        exhausted = true
        break
      }
      const entries = load(r.value.leaf.hash)
      entries.catch(() => {}) // surfaced when awaited below
      queue.push({ entries, skip: r.value.skip, after: r.value.after })
    }
  }
  for (;;) {
    await fill()
    const next = queue.shift()
    if (!next) return
    const entries = await next.entries
    let i = 0
    if (next.after !== undefined) {
      while (i < entries.length && compareUtf8(spec.key(entries[i]!), next.after) <= 0) i++
    }
    i += next.skip
    for (; i < entries.length; i++) yield entries[i]!
  }
}

export interface DiffEntry<E> {
  key: string
  /** Entry in the first tree, or null when added. */
  before: E | null
  /** Entry in the second tree, or null when removed. */
  after: E | null
}

type Item<E> = { node: NodeDesc } | { entry: E }

/**
 * Entries that differ between two trees, in key order. Subtrees with equal hashes
 * hold identical entries and are skipped without being read; because node
 * boundaries depend only on keys, unchanged regions line up and the walk costs
 * O(changes × height) node reads.
 *
 * `after` resumes past a key: subtrees that end at or before it are skipped
 * unread, so a page of a long diff costs that page, not everything before it.
 */
export async function* diffTrees<E>(
  source: NodeSource<E>,
  a: string | null,
  b: string | null,
  opts: { after?: string | undefined } = {},
): AsyncGenerator<DiffEntry<E>> {
  const spec = source.spec
  const after = opts.after
  /** Drop leading items wholly at or before `after`. */
  const prune = (items: Item<E>[]) => {
    if (after === undefined) return
    while (items.length > 0) {
      const head = items[0]!
      const last = 'node' in head ? head.node.lastKey : spec.key(head.entry)
      if (compareUtf8(last, after) > 0) return
      items.shift()
    }
  }
  const xs: Item<E>[] = a === null ? [] : [{ node: await rootDesc(source, a) }]
  const ys: Item<E>[] = b === null ? [] : [{ node: await rootDesc(source, b) }]
  const expand = async (items: Item<E>[]) => {
    const head = items.shift() as { node: NodeDesc }
    const n = await source.node(head.node.hash)
    const children: Item<E>[] =
      n.kind === 'leaf'
        ? n.entries.map((entry) => ({ entry }))
        : n.children.map((node) => ({ node }))
    items.unshift(...children)
  }
  for (;;) {
    prune(xs)
    prune(ys)
    const x = xs[0]
    const y = ys[0]
    if (!x && !y) return
    if (x && 'node' in x && y && 'node' in y && x.node.hash === y.node.hash) {
      xs.shift()
      ys.shift()
      continue
    }
    if (x && 'node' in x && (!y || 'entry' in y || x.node.level >= y.node.level)) {
      await expand(xs)
      continue
    }
    if (y && 'node' in y) {
      await expand(ys)
      continue
    }
    // Both heads are entries (or one side is exhausted).
    const ex = x && 'entry' in x ? x.entry : undefined
    const ey = y && 'entry' in y ? y.entry : undefined
    if (ex !== undefined && (ey === undefined || compareUtf8(spec.key(ex), spec.key(ey)) < 0)) {
      xs.shift()
      yield { key: spec.key(ex), before: ex, after: null }
    } else if (
      ey !== undefined &&
      (ex === undefined || compareUtf8(spec.key(ey), spec.key(ex)) < 0)
    ) {
      ys.shift()
      yield { key: spec.key(ey), before: null, after: ey }
    } else {
      xs.shift()
      ys.shift()
      if (!spec.same(ex!, ey!)) yield { key: spec.key(ex!), before: ex!, after: ey! }
    }
  }
}

/**
 * The nodes of tree `b` that tree `a` doesn't have at the same position, top
 * down (a parent before its children). The walk is `diffTrees`' and costs the
 * same: equal subtrees are skipped unread. This is what a sync sends.
 *
 * `after` resumes a walk that stopped after the leaf whose last key it is: only
 * nodes whose keys all come after it are listed (the ones spanning it were
 * listed before their children, so before the stop).
 */
export async function* newNodes<E>(
  source: NodeSource<E>,
  a: string | null,
  b: string | null,
  opts: { after?: string | null } = {},
): AsyncGenerator<NodeDesc> {
  if (b === null || a === b) return
  const spec = source.spec
  const after = opts.after ?? null
  type Side = ({ node: NodeDesc; low: string | null } | { entry: E })[]
  const xs: Side = a === null ? [] : [{ node: await rootDesc(source, a), low: null }]
  const ys: Side = [{ node: await rootDesc(source, b), low: null }]
  const expand = async (items: Side) => {
    const head = items.shift() as { node: NodeDesc; low: string | null }
    const n = await source.node(head.node.hash)
    let low = head.low
    const children: Side = []
    if (n.kind === 'leaf') for (const entry of n.entries) children.push({ entry })
    else
      for (const node of n.children) {
        children.push({ node, low })
        low = node.lastKey
      }
    items.unshift(...children)
  }
  // Items entirely at or before the cursor are done.
  const done = (it: Side[number]) =>
    after !== null && compareUtf8('node' in it ? it.node.lastKey : spec.key(it.entry), after) <= 0
  for (;;) {
    while (xs[0] && done(xs[0])) xs.shift()
    while (ys[0] && done(ys[0])) ys.shift()
    const x = xs[0]
    const y = ys[0]
    if (!y) return
    if (x && 'node' in x && 'node' in y && x.node.hash === y.node.hash) {
      xs.shift()
      ys.shift()
      continue
    }
    if (x && 'node' in x && ('entry' in y || x.node.level >= y.node.level)) {
      await expand(xs)
      continue
    }
    if ('node' in y) {
      if (after === null || (y.low !== null && compareUtf8(y.low, after) >= 0)) yield y.node
      await expand(ys)
      continue
    }
    // Both heads are entries: keep the two sides aligned by key.
    const ky = spec.key(y.entry)
    const c = x && 'entry' in x ? compareUtf8(spec.key(x.entry), ky) : 1
    if (c <= 0) xs.shift()
    if (c >= 0) ys.shift()
  }
}
