/**
 * fsck for trees: validate structure, not just hashes.
 *
 * A node can hash correctly and still break the rules: keys out of order, a
 * boundary in the wrong place, wrong counts, wrong levels. Such a tree gives a
 * valid-looking but different root for the same entries, which breaks
 * convergence. `verifyTree` checks every node against its parent's pointer and
 * then rebuilds the tree from its entries; the rebuilt root must be the same
 * hash, which covers every chunking rule at once.
 */
import { compareUtf8 } from '../utf8.js'
import { TreeBuilder } from './builder.js'
import { type Chunking } from './chunking.js'
import { describeNode, type NodeDesc } from './node.js'
import type { NodeSource } from './source.js'

export interface VerifyResult {
  ok: boolean
  errors: string[]
  count: number
  bytes: number
  nodes: number
}

export async function verifyTree<E>(
  source: NodeSource<E>,
  root: string | null,
  opts: { chunking?: Chunking; maxErrors?: number } = {},
): Promise<VerifyResult> {
  const result: VerifyResult = { ok: true, errors: [], count: 0, bytes: 0, nodes: 0 }
  if (root === null) return result
  const maxErrors = opts.maxErrors ?? 20
  const fail = (msg: string) => {
    result.ok = false
    if (result.errors.length < maxErrors) result.errors.push(msg)
  }
  const spec = source.spec
  const rebuilt = new TreeBuilder(
    spec,
    { leaf() {}, interior() {} },
    opts.chunking ? { chunking: opts.chunking } : {},
  )
  let prev: string | null = null

  const walk = async (hash: string, expect: NodeDesc | null): Promise<void> => {
    let node
    try {
      node = await source.node(hash)
    } catch (err) {
      fail(`${hash}: ${(err as Error).message}`)
      return
    }
    result.nodes++
    const actual = describeNode(spec, node)
    if (expect) {
      if (actual.level !== expect.level)
        fail(`${hash}: level ${actual.level}, parent says ${expect.level}`)
      if (actual.lastKey !== expect.lastKey) fail(`${hash}: last key differs from parent pointer`)
      if (actual.count !== expect.count)
        fail(`${hash}: count ${actual.count}, parent says ${expect.count}`)
      if (actual.bytes !== expect.bytes)
        fail(`${hash}: bytes ${actual.bytes}, parent says ${expect.bytes}`)
    }
    if (node.kind === 'leaf') {
      for (const e of node.entries) {
        const k = spec.key(e)
        if (prev !== null && compareUtf8(prev, k) >= 0) {
          fail(`${hash}: key ${JSON.stringify(k)} out of order`)
          continue
        }
        prev = k
        result.count++
        result.bytes += spec.bytes(e)
        rebuilt.addEntry(e)
      }
      return
    }
    for (const child of node.children) await walk(child.hash, child)
  }

  await walk(root, null)
  if (result.ok) {
    const { root: again } = rebuilt.finish()
    if (again?.hash !== root) {
      fail(`Tree is not canonical: rebuilding its entries gives root ${again?.hash ?? 'null'}`)
    }
  }
  return result
}
