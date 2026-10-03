/**
 * Tree nodes: canonical encoding, hashing and decoding.
 *
 *   leaf:      {"e":[entry, ...],"t":"leaf"}
 *   interior:  {"e":[[lastKey, childHash, count, bytes], ...],"l":level,"t":"node"}
 *
 * Both are JCS (keys sorted: "e" < "l" < "t"). A node's hash is the lowercase hex
 * SHA-256 of those exact bytes. Leaf entries depend on the tree kind (TreeSpec).
 */
import { sha256Hex } from '../hash.js'
import { compareUtf8 } from '../utf8.js'

const HEX64 = /^[0-9a-f]{64}$/

/** A child pointer as stored in an interior node, plus the child's level. */
export interface NodeDesc {
  level: number
  hash: string
  /** The last key under the node. Boundaries are decided on it. */
  lastKey: string
  /** Entries under the node. */
  count: number
  /** Sum of entry sizes under the node (TreeSpec.bytes). */
  bytes: number
}

/**
 * A tree kind: how its leaf entries are encoded. The encoding of an entry must be
 * the JCS form of a JSON array, so that a node is JCS as a whole.
 */
export interface TreeSpec<E> {
  readonly name: string
  key(e: E): string
  /** JCS of the entry's tuple, e.g. `["id","<hash>",123]`. */
  encode(e: E): string
  /** Inverse of encode, from the parsed tuple. Throws on a malformed tuple. */
  decode(tuple: unknown): E
  /** Size contributed to `bytes`. */
  bytes(e: E): number
  /** Same content (for change detection): same key and same value. */
  same(a: E, b: E): boolean
}

export type DecodedNode<E> =
  | { kind: 'leaf'; hash: string; entries: E[] }
  | { kind: 'node'; hash: string; level: number; children: NodeDesc[] }

export function encodeLeaf<E>(spec: TreeSpec<E>, entries: readonly E[]): string {
  let out = '{"e":['
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) out += ','
    out += spec.encode(entries[i]!)
  }
  return out + '],"t":"leaf"}'
}

export function encodeInterior(level: number, children: readonly NodeDesc[]): string {
  let out = '{"e":['
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!
    if (i > 0) out += ','
    out += '[' + JSON.stringify(c.lastKey) + ',"' + c.hash + '",' + c.count + ',' + c.bytes + ']'
  }
  return out + '],"l":' + level + ',"t":"node"}'
}

export function hashNode(json: string): string {
  return sha256Hex(json)
}

export class NodeFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NodeFormatError'
  }
}

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

/**
 * Decode a node from its stored JSON and check it: the bytes hash to `expectedHash`
 * (when given), the shape is right for the tree kind, and the bytes are canonical
 * (re-encoding gives the same string). A non-canonical encoding of the same content
 * would have a different hash, so accepting one would let two hashes name one node.
 *
 * Child levels can't be checked here: an interior node's children are one level
 * below it, which the decoder records; the reader checks it when it loads them.
 */
export function decodeNode<E>(
  spec: TreeSpec<E>,
  json: string,
  expectedHash?: string,
): DecodedNode<E> {
  const hash = hashNode(json)
  if (expectedHash !== undefined && hash !== expectedHash) {
    throw new NodeFormatError(`Node hash mismatch: expected ${expectedHash}, got ${hash}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new NodeFormatError('Node is not valid JSON')
  }
  const obj = parsed as { t?: unknown; e?: unknown; l?: unknown }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.e) || obj.e.length === 0) {
    throw new NodeFormatError('Node must have a non-empty "e" array')
  }
  if (obj.t === 'leaf') {
    if (Object.keys(obj).length !== 2) throw new NodeFormatError('Leaf has unexpected fields')
    const entries = obj.e.map((t) => spec.decode(t))
    for (let i = 1; i < entries.length; i++) {
      if (compareUtf8(spec.key(entries[i - 1]!), spec.key(entries[i]!)) >= 0) {
        throw new NodeFormatError('Leaf keys are not strictly increasing')
      }
    }
    if (encodeLeaf(spec, entries) !== json) throw new NodeFormatError('Leaf is not canonical')
    return { kind: 'leaf', hash, entries }
  }
  if (obj.t === 'node') {
    if (Object.keys(obj).length !== 3) throw new NodeFormatError('Node has unexpected fields')
    const level = obj.l
    if (!Number.isSafeInteger(level) || (level as number) < 1) {
      throw new NodeFormatError('Interior node level must be an integer ≥ 1')
    }
    const children: NodeDesc[] = obj.e.map((t) => {
      if (!Array.isArray(t) || t.length !== 4) throw new NodeFormatError('Bad interior entry')
      const [lastKey, h, count, bytes] = t as unknown[]
      if (typeof lastKey !== 'string' || typeof h !== 'string' || !HEX64.test(h)) {
        throw new NodeFormatError('Bad interior entry')
      }
      if (!isCount(count) || count < 1 || !isCount(bytes)) {
        throw new NodeFormatError('Bad interior entry counts')
      }
      return { level: (level as number) - 1, hash: h, lastKey, count, bytes }
    })
    for (let i = 1; i < children.length; i++) {
      if (compareUtf8(children[i - 1]!.lastKey, children[i]!.lastKey) >= 0) {
        throw new NodeFormatError('Interior keys are not strictly increasing')
      }
    }
    if (encodeInterior(level as number, children) !== json) {
      throw new NodeFormatError('Interior node is not canonical')
    }
    return { kind: 'node', hash, level: level as number, children }
  }
  throw new NodeFormatError('Node "t" must be "leaf" or "node"')
}

/** The descriptor of a decoded node, as its parent would hold it. */
export function describeNode<E>(spec: TreeSpec<E>, node: DecodedNode<E>): NodeDesc {
  if (node.kind === 'leaf') {
    let bytes = 0
    for (const e of node.entries) bytes += spec.bytes(e)
    return {
      level: 0,
      hash: node.hash,
      lastKey: spec.key(node.entries[node.entries.length - 1]!),
      count: node.entries.length,
      bytes,
    }
  }
  let count = 0
  let bytes = 0
  for (const c of node.children) {
    count += c.count
    bytes += c.bytes
  }
  return {
    level: node.level,
    hash: node.hash,
    lastKey: node.children[node.children.length - 1]!.lastKey,
    count,
    bytes,
  }
}

// --- Tree kinds ---------------------------------------------------------------

/**
 * Record trees: key = record id, value = record hash, plus the canonical record's
 * size in bytes. `body` (the canonical record line) travels with an entry while
 * it is being written or read; it is never part of the node.
 */
export interface RecordEntry {
  key: string
  hash: string
  size: number
  body?: string
}

export const recordTree: TreeSpec<RecordEntry> = {
  name: 'record',
  key: (e) => e.key,
  encode: (e) => '[' + JSON.stringify(e.key) + ',"' + e.hash + '",' + e.size + ']',
  decode(t) {
    if (!Array.isArray(t) || t.length !== 3) throw new NodeFormatError('Bad record entry')
    const [key, hash, size] = t as unknown[]
    if (
      typeof key !== 'string' ||
      typeof hash !== 'string' ||
      !HEX64.test(hash) ||
      !isCount(size)
    ) {
      throw new NodeFormatError('Bad record entry')
    }
    return { key, hash, size }
  },
  bytes: (e) => e.size,
  same: (a, b) => a.key === b.key && a.hash === b.hash,
}

/** File trees: key = file hash (hex), value = file size in bytes. */
export interface FileEntry {
  key: string
  size: number
}

export const fileTree: TreeSpec<FileEntry> = {
  name: 'file',
  key: (e) => e.key,
  encode: (e) => '["' + e.key + '",' + e.size + ']',
  decode(t) {
    if (!Array.isArray(t) || t.length !== 2) throw new NodeFormatError('Bad file entry')
    const [key, size] = t as unknown[]
    if (typeof key !== 'string' || !HEX64.test(key) || !isCount(size)) {
      throw new NodeFormatError('Bad file entry')
    }
    return { key, size }
  },
  bytes: (e) => e.size,
  same: (a, b) => a.key === b.key && a.size === b.size,
}

/**
 * Not protocol: a sidecar tree of reference counts (key = file hash, value =
 * number of references from a set's records). Lets a commit keep file sets
 * correct in O(changes). Same tree code, so the same reuse and caching.
 */
export interface CountEntry {
  key: string
  n: number
}

export const countTree: TreeSpec<CountEntry> = {
  name: 'count',
  key: (e) => e.key,
  encode: (e) => '[' + JSON.stringify(e.key) + ',' + e.n + ']',
  decode(t) {
    if (!Array.isArray(t) || t.length !== 2) throw new NodeFormatError('Bad count entry')
    const [key, n] = t as unknown[]
    if (typeof key !== 'string' || !isCount(n) || n < 1)
      throw new NodeFormatError('Bad count entry')
    return { key, n }
  },
  bytes: () => 0,
  same: (a, b) => a.key === b.key && a.n === b.n,
}
