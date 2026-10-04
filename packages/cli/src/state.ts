/** Reading a local version back: its root, its sets, its schemas and its records. */
import {
  compareUtf8,
  emptySet,
  type PrivateSetObject,
  type RecordEntry,
  recordTree,
  type Repo,
  RepoSource,
  type SetObject,
  type VersionRoot,
} from '@underlay/protocol'

import type { Local, LocalVersion } from './local.js'

export interface VersionState {
  version: LocalVersion
  root: VersionRoot
  public: SetObject
  /** Empty when the version has no private set or this repository doesn't hold it. */
  private: PrivateSetObject | SetObject
  /** Every type's schema, from whichever set holds the type. */
  schemas: Record<string, Record<string, unknown>>
}

export async function versionState(local: Local, v: LocalVersion): Promise<VersionState> {
  const repo = local.repo
  const root = await repo.root(v.hash)
  const priv = v.sets === 'all' && root.private ? await repo.privateSet(root.private) : emptySet()
  const schemas: Record<string, Record<string, unknown>> = {}
  for (const set of [root.public, priv]) {
    for (const [slug, t] of Object.entries(set.types)) {
      schemas[slug] ??= await repo.schema(t.schema)
    }
  }
  return { version: v, root, public: root.public, private: priv, schemas }
}

/** A record of a tree, with its body, by id. O(height). */
export async function recordById(
  repo: Repo,
  root: string | null,
  id: string,
): Promise<RecordEntry | null> {
  if (!root) return null
  const source = new RepoSource(recordTree, repo)
  let hash = root
  for (;;) {
    const node = await source.node(hash)
    if (node.kind === 'leaf') {
      return (await source.leafEntries(hash)).find((e) => e.key === id) ?? null
    }
    const child = node.children.find((c) => compareUtf8(id, c.lastKey) <= 0)
    if (!child) return null
    hash = child.hash
  }
}
