/**
 * Where tree readers get nodes from. The server backs this with the blob store
 * plus caches; tests use a Map.
 */
import { type DecodedNode, decodeNode, describeNode, type NodeDesc, type TreeSpec } from './node.js'

export interface NodeSource<E> {
  readonly spec: TreeSpec<E>
  /** Load and verify a node. */
  node(hash: string): Promise<DecodedNode<E>>
  /**
   * A leaf's entries with their payloads (record bodies), for rewriting a leaf.
   * Sources whose entries carry no payload return the node's entries.
   */
  leafEntries(hash: string): Promise<E[]>
}

/** A source over node JSON held in memory, keyed by hash. */
export class MapSource<E> implements NodeSource<E> {
  constructor(
    readonly spec: TreeSpec<E>,
    readonly nodes: Map<string, string>,
    readonly payloads?: Map<string, readonly E[]>,
  ) {}

  async node(hash: string): Promise<DecodedNode<E>> {
    const json = this.nodes.get(hash)
    if (json === undefined) throw new Error(`Node ${hash} not found`)
    return decodeNode(this.spec, json, hash)
  }

  async leafEntries(hash: string): Promise<E[]> {
    const withPayload = this.payloads?.get(hash)
    if (withPayload) return withPayload.slice()
    const n = await this.node(hash)
    if (n.kind !== 'leaf') throw new Error(`Node ${hash} is not a leaf`)
    return n.entries
  }
}

/** The full descriptor of a tree's root (level and last key come from the node). */
export async function rootDesc<E>(source: NodeSource<E>, hash: string): Promise<NodeDesc> {
  return describeNode(source.spec, await source.node(hash))
}

/**
 * Finish `TreeBuilder.finish` when it reports `unresolved`: walk down while the
 * node has a single child. See the builder for why.
 */
export async function resolveRoot<E>(source: NodeSource<E>, desc: NodeDesc): Promise<NodeDesc> {
  let d = desc
  while (d.level > 0) {
    const n = await source.node(d.hash)
    if (n.kind !== 'node' || n.children.length !== 1) break
    d = n.children[0]!
  }
  return d
}
