import { type RecordEntry, recordTree } from '../tree/node.js'
import { newNodes } from '../tree/read.js'
/**
 * Converting a collection from today's layout to layout F (planning: layout-f-pr.md,
 * "PR 2"). A version's record trees are walked against the version before's; each
 * leaf it adds is read from its body (today's layout) and the records F's index
 * doesn't hold yet are written to the set's packs, as stored (an out-of-line
 * record stays a pointer). Nodes don't change, so neither do roots or version
 * hashes. A record is written once however many versions hold it, and a walk that
 * runs again (a retried job) writes nothing twice.
 */
import { compareUtf8 } from '../utf8.js'
import { KeyedLayout, type RecordSet } from './layouts/index.js'
import type { Repo } from './repo.js'
import { RepoSource } from './repo.js'

/** One record tree of a version: a set's tree of a type, and the version before's. */
export interface ConvertTree {
  set: RecordSet
  type: string
  base: string | null
  root: string | null
}

export interface ConvertBudget {
  /** Leaves to read at most before stopping (one at least). */
  leaves: number
  /** Stop past this time (ms since the epoch). */
  until: number
}

export interface ConvertProgress {
  /** The last key of the last leaf done when the budget ran out; null when the tree is done. */
  after: string | null
  leaves: number
  records: number
  /** Records the index already held (an earlier version's, or a job run again). */
  skipped: number
}

/**
 * Write the records of `tree`'s new leaves (from `from`, today's layout) into
 * `to`'s set (layout F), from `after` on, within `budget`.
 */
export async function convertTree(
  from: Repo,
  to: Repo,
  tree: ConvertTree,
  after: string | null,
  budget: ConvertBudget,
): Promise<ConvertProgress> {
  const store = to.records?.[tree.set]
  if (!(store instanceof KeyedLayout)) throw new Error('convertTree: the target is not on layout F')
  if (from.records) throw new Error("convertTree: the source is not on today's layout")
  const out: ConvertProgress = { after: null, leaves: 0, records: 0, skipped: 0 }
  if (tree.root === null) return out
  const source = new RepoSource(recordTree, from)
  const writer = store.writer()
  try {
    for await (const n of newNodes(source, tree.base, tree.root, { after })) {
      if (n.level !== 0) continue
      const node = await from.decoded(recordTree, n.hash)
      if (node.kind !== 'leaf') continue
      const entries = node.entries as RecordEntry[]
      const missing = new Set(await store.missing(tree.type, entries))
      out.skipped += entries.length - missing.size
      if (missing.size) {
        // The stored body, streamed (an out-of-line record's pointer stays a pointer).
        let i = 0
        for await (const line of from.bodyLineStream({ hash: n.hash, entries }, undefined, {
          pointers: true,
        })) {
          if (missing.has(i)) {
            writer.add(tree.type, entries[i]!, line)
            out.records++
          }
          if (++i % 1024 === 0) await writer.drain?.()
        }
        if (i !== entries.length)
          throw new Error(
            `convertTree: leaf ${n.hash} has ${i} lines for ${entries.length} entries`,
          )
        await writer.drain?.()
      }
      out.leaves++
      if (out.leaves >= budget.leaves || Date.now() >= budget.until) {
        out.after = n.lastKey
        break
      }
    }
  } finally {
    await writer.finish()
  }
  // A leaf past the cursor's last key can't come before it.
  if (out.after !== null && after !== null && compareUtf8(out.after, after) <= 0)
    throw new Error('convertTree: the walk went backwards')
  return out
}

/**
 * A version's record trees in a fixed order (public then private, types by slug),
 * each with the same set's tree of the type in the version before (`prev`, null
 * for the first): what `convertTree` walks.
 */
export async function versionTrees(
  repo: Repo,
  version: string,
  prev: string | null,
): Promise<ConvertTree[]> {
  const setsOf = async (hash: string | null) => {
    if (hash === null)
      return { public: {}, private: {} } as Record<RecordSet, Record<string, string | null>>
    const root = await repo.root(hash)
    const priv = root.private ? await repo.privateSet(root.private) : null
    const roots = (types: Record<string, { root: string | null }> | undefined) =>
      Object.fromEntries(Object.entries(types ?? {}).map(([slug, t]) => [slug, t.root]))
    return { public: roots(root.public.types), private: roots(priv?.types) }
  }
  const now = await setsOf(version)
  const before = await setsOf(prev)
  const out: ConvertTree[] = []
  for (const set of ['public', 'private'] as const)
    for (const type of Object.keys(now[set]).sort(compareUtf8))
      out.push({ set, type, base: before[set][type] ?? null, root: now[set][type] ?? null })
  return out
}
