/**
 * Streaming tree builder.
 *
 * Feed entries in strictly increasing key order (UTF-8 byte order) with
 * `addEntry`, or whole existing nodes with `addNode`, then call `finish` for the
 * root. Each level has its own chunker; when a node ends, the builder hands it to
 * the sink and pushes its descriptor into the level above. Memory is one pending
 * node per level.
 *
 * `addNode` is what makes incremental commits O(changes): a node from the base
 * tree can be reused unchanged when every level at or below it is empty, i.e.
 * the output stream is sitting exactly on a boundary. The node's own end was a
 * boundary in the base tree (or the end of the tree), and boundaries depend only
 * on keys and the position since the previous boundary, so it ends in the same
 * place here. Its descriptor goes into the level above as if it had just been
 * built.
 *
 * The root is the only node of the first level that has exactly one node. A
 * level above it may have started a node with that one child (when its last key
 * also satisfies the higher boundary); that node is written but unreachable,
 * which is harmless and rare.
 */
import { compareUtf8 } from '../utf8.js'
import { boundaryBytes, type Chunking, protocolChunking } from './chunking.js'
import { encodeInterior, encodeLeaf, hashNode, type NodeDesc, type TreeSpec } from './node.js'

export interface TreeSink<E> {
  /**
   * A finished leaf. `entries` are all of the leaf's entries; the first `spilled`
   * of them were already passed to `spill` (and may have dropped their payloads).
   */
  leaf(desc: NodeDesc, json: string, entries: readonly E[], spilled: number): void
  interior(desc: NodeDesc, json: string, children: readonly NodeDesc[]): void
  /**
   * Called when the pending leaf's payload passes `spillBytes`, with the entries
   * added since the last spill, so a sink can write record bodies in bounded parts
   * instead of holding a whole leaf's bodies in memory.
   */
  spill?(entries: readonly E[]): void
  /**
   * Backpressure for sinks that write asynchronously: async callers (mergeTree)
   * await it between leaves so pending writes stay bounded.
   */
  drain?(): Promise<void>
}

export interface BuilderOptions<E> {
  chunking?: Chunking
  /** Payload size of an entry (e.g. record body length). Needed for spilling. */
  payloadBytes?: (e: E) => number
  /** Drop an entry's payload after it was spilled. */
  dropPayload?: (e: E) => void
  /** Spill the pending leaf's payload when it reaches this many bytes. */
  spillBytes?: number
}

export class TreeBuilder<E> {
  readonly #spec: TreeSpec<E>
  readonly #sink: TreeSink<E>
  readonly #chunking: Chunking
  readonly #opts: BuilderOptions<E>

  // Level 0: pending leaf entries.
  #leaf: E[] = []
  #leafBytes = 0
  #spilled = 0
  #payload = 0
  // Level h ≥ 1: pending children (level h−1 descriptors) of the level-h node.
  readonly #pending: NodeDesc[][] = []
  // Nodes completed (built or reused) at each level, and the most recent one.
  readonly #nodes: number[] = []
  readonly #last: NodeDesc[] = []
  // The last interior node built at each level, with its children (for finish).
  readonly #lastBuilt: ({ hash: string; children: NodeDesc[] } | undefined)[] = []
  #lastKey: string | null = null
  #finished = false

  constructor(spec: TreeSpec<E>, sink: TreeSink<E>, opts: BuilderOptions<E> = {}) {
    this.#spec = spec
    this.#sink = sink
    this.#chunking = opts.chunking ?? protocolChunking
    this.#opts = opts
  }

  /** True when no level at or below `level` holds a partial node. */
  emptyThrough(level: number): boolean {
    if (this.#leaf.length > 0) return false
    for (let h = 1; h <= level; h++) {
      if ((this.#pending[h]?.length ?? 0) > 0) return false
    }
    return true
  }

  get lastKey(): string | null {
    return this.#lastKey
  }

  addEntry(e: E): void {
    const key = this.#spec.key(e)
    this.#advance(key)
    this.#leaf.push(e)
    this.#leafBytes += this.#spec.bytes(e)
    const { payloadBytes, spillBytes } = this.#opts
    if (payloadBytes && spillBytes !== undefined) {
      this.#payload += payloadBytes(e)
      if (this.#payload >= spillBytes) this.#spill()
    }
    if (this.#chunking.ends(0, boundaryBytes(key), this.#leaf.length)) this.#emitLeaf()
  }

  /** Reuse an existing node. Requires `emptyThrough(desc.level)`. */
  addNode(desc: NodeDesc): void {
    if (!this.emptyThrough(desc.level)) {
      throw new Error('TreeBuilder.addNode: a lower level holds a partial node')
    }
    this.#advance(desc.lastKey)
    this.#push(desc)
  }

  /**
   * Finish every level and return the root, or null for an empty tree.
   *
   * The root is the node of the lowest level that has exactly one node. Flush
   * levels upward until the highest level holds a single node, then walk down
   * while that node has a single child. A node reused through `addNode` has
   * children the builder never saw; if the walk reaches one, `unresolved` is set
   * and the caller finishes the walk by loading nodes (`resolveRoot`).
   */
  finish(): { root: NodeDesc | null; unresolved: boolean } {
    if (this.#finished) throw new Error('TreeBuilder.finish called twice')
    this.#finished = true
    if (this.#leaf.length > 0) this.#emitLeaf()
    if (this.#nodes.length === 0) return { root: null, unresolved: false }
    for (let h = 0; ; h++) {
      const top = this.#nodes.length - 1
      if (h === top && this.#nodes[h] === 1) break
      if ((this.#pending[h + 1]?.length ?? 0) > 0) this.#emitInterior(h + 1)
    }
    let root = this.#last[this.#nodes.length - 1]!
    while (root.level > 0) {
      // The chain down from the top is always the last node of each level.
      const built = this.#lastBuilt[root.level]
      const kids = built?.hash === root.hash ? built.children : undefined
      if (!kids) return { root, unresolved: true }
      if (kids.length !== 1) break
      root = kids[0]!
    }
    return { root, unresolved: false }
  }

  #advance(key: string): void {
    if (this.#finished) throw new Error('TreeBuilder: add after finish')
    if (this.#lastKey !== null && compareUtf8(this.#lastKey, key) >= 0) {
      throw new Error(
        `TreeBuilder: keys out of order (${JSON.stringify(key)} after ${JSON.stringify(this.#lastKey)})`,
      )
    }
    this.#lastKey = key
  }

  #spill(): void {
    const batch = this.#leaf.slice(this.#spilled)
    this.#sink.spill?.(batch)
    if (this.#opts.dropPayload) for (const e of batch) this.#opts.dropPayload(e)
    this.#spilled = this.#leaf.length
    this.#payload = 0
  }

  #emitLeaf(): void {
    const entries = this.#leaf
    const json = encodeLeaf(this.#spec, entries)
    const desc: NodeDesc = {
      level: 0,
      hash: hashNode(json),
      lastKey: this.#spec.key(entries[entries.length - 1]!),
      count: entries.length,
      bytes: this.#leafBytes,
    }
    this.#sink.leaf(desc, json, entries, this.#spilled)
    this.#leaf = []
    this.#leafBytes = 0
    this.#spilled = 0
    this.#payload = 0
    this.#push(desc)
  }

  #emitInterior(level: number): void {
    const children = this.#pending[level]!
    this.#pending[level] = []
    const json = encodeInterior(level, children)
    let count = 0
    let bytes = 0
    for (const c of children) {
      count += c.count
      bytes += c.bytes
    }
    const desc: NodeDesc = {
      level,
      hash: hashNode(json),
      lastKey: children[children.length - 1]!.lastKey,
      count,
      bytes,
    }
    this.#sink.interior(desc, json, children)
    this.#lastBuilt[level] = { hash: desc.hash, children }
    this.#push(desc)
  }

  /** Record a completed level-h node and push it into level h+1. */
  #push(desc: NodeDesc): void {
    const h = desc.level
    this.#nodes[h] = (this.#nodes[h] ?? 0) + 1
    this.#last[h] = desc
    const up = (this.#pending[h + 1] ??= [])
    up.push(desc)
    if (this.#chunking.ends(h + 1, boundaryBytes(desc.lastKey), up.length)) {
      this.#emitInterior(h + 1)
    }
  }
}

/** A sink that only collects nodes in memory: for tests, fsck and small trees. */
export class MemorySink<E> implements TreeSink<E> {
  readonly nodes = new Map<string, string>()
  readonly leaves = new Map<string, readonly E[]>()
  leaf(desc: NodeDesc, json: string, entries: readonly E[]): void {
    this.nodes.set(desc.hash, json)
    this.leaves.set(desc.hash, entries.slice())
  }
  interior(desc: NodeDesc, json: string): void {
    this.nodes.set(desc.hash, json)
  }
}

/** Build a tree from entries already sorted by key. */
export function buildTree<E>(
  spec: TreeSpec<E>,
  sink: TreeSink<E>,
  entries: Iterable<E>,
  opts?: BuilderOptions<E>,
): NodeDesc | null {
  const b = new TreeBuilder(spec, sink, opts)
  for (const e of entries) b.addEntry(e)
  // Nothing was reused, so the builder knows every node and the root is resolved.
  return b.finish().root
}
