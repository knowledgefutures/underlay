/**
 * The layout this test project runs on (vitest.config.ts), how a test says it does not
 * apply to one, and reads that work on any layout. Every skip on v3 carries its reason,
 * so what v3 does not do yet reads from the suite (v3-deploy-plan.md, Phases 1 and 3).
 */
import { getEntry, recordTree, RepoSource, v3 } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'
import { describe, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import type { CollectionLayout, Ports } from '../src/ports.js'
import { metadataOf, viewOf } from '../src/v3/catalog.js'

export const testLayout = (process.env.UNDERLAY_TEST_LAYOUT ?? 'today') as CollectionLayout
export const onV3 = testLayout === 'v3'

/**
 * Why v3 skips a test: no private records or types (decision 1), v2's own objects, not
 * yet built for v3 (and which phase or decision it waits on), or a behaviour v3 changes.
 */
export type NotOnV3 =
  | 'private records or types: a v3 collection is private or public as a whole'
  | "v2's trees, roots, logs, or packs: v3 has none"
  | `not on v3 yet: ${string}`
  | `differs on v3: ${string}`

/** `it`, skipped on v3 for the reason given. */
export const itNotOnV3 = (_reason: NotOnV3) => it.skipIf(onV3)
/** `describe`, skipped on v3 for the reason given. */
export const describeNotOnV3 = (_reason: NotOnV3) => describe.skipIf(onV3)

async function seqOf(ports: Ports, collectionId: string, versionHash: string) {
  const [v] = await ports.db
    .select({ seq: schema.versions.seq })
    .from(schema.versions)
    .where(
      and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.hash, versionHash)),
    )
  if (!v) throw new Error(`No version ${versionHash}`)
  return v.seq
}

/** A record's hash at a version (by its id), in either set, or null: on any layout. */
export async function recordHashAt(
  ports: Ports,
  collectionId: string,
  versionHash: string,
  type: string,
  id: string,
): Promise<string | null> {
  if ((await ports.stores.layoutOf(collectionId)) === 'v3') {
    const view = await viewOf(
      ports.stores.v3,
      collectionId,
      await seqOf(ports, collectionId, versionHash),
    )
    return (await v3.getRecord(ports.stores.v3, view!, type, id))?.hash ?? null
  }
  const repo = await ports.stores.forCollection(collectionId)
  const root = await repo.root(versionHash)
  const source = new RepoSource(recordTree, repo)
  for (const set of [root.public, root.private ? await repo.privateSet(root.private) : null]) {
    const tree = set?.types[type]?.root
    if (!tree) continue
    const e = await getEntry(source, tree, id)
    if (e) return e.hash
  }
  return null
}

/** A version's metadata: on any layout. */
export async function metadataAt(
  ports: Ports,
  collectionId: string,
  versionHash: string,
): Promise<Record<string, unknown> | null> {
  if ((await ports.stores.layoutOf(collectionId)) === 'v3') {
    const view = await viewOf(
      ports.stores.v3,
      collectionId,
      await seqOf(ports, collectionId, versionHash),
    )
    return metadataOf(ports.stores.v3, view)
  }
  const repo = await ports.stores.forCollection(collectionId)
  return (await repo.root(versionHash)).metadata
}
