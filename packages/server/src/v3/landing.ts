/**
 * Landing a commit: the short last step of every v3 commit, the one that runs one at a
 * time for a collection (decision 4). Everything heavy happens before it, in the job that
 * prepares the change: building the files, looking up what each row replaces, verifying.
 * Landing then:
 *
 *   1. brings D1 up to the log (`syncCatalog`), and checks the head is still the one the
 *      change was prepared against; if not, the caller prepares again;
 *   2. creates the commit (`createCommit`, with no retries: a lost number means another
 *      commit landed, so the counts made against the old head no longer hold). The change's
 *      files were checked and installed among the stored files by whoever prepared it; landing
 *      only makes sure they are there;
 *   3. records it in D1 and queues what follows a commit.
 *
 * A `Landing` is plain JSON, so a Durable Object can take it (Phase 2) as well as the
 * in-process queue (Node, tests).
 */
import { v3 } from '@underlay/protocol'

import type { Ports } from '../ports.js'
import {
  applyStats,
  type CommitStats,
  emptyStats,
  lastRow,
  recordCommit,
  statsOfRow,
  syncCatalog,
} from './catalog.js'

export interface Landing {
  collectionId: string
  /** The upload session the change's files came in (installed already; cleared after). */
  session: string
  /** The kind of change, for the semver (protocol-v3 4.4), as its preparer found it. */
  bump: 'major' | 'minor' | 'patch'
  change: v3.Change
  /** The version id of the head the change was prepared against (null: no commits yet). */
  expectHead: string | null
  /** What the change does to that head's counts. */
  stats: CommitStats
  /** Types whose schema the change sets (its hash) or removes (null). */
  schemaChanges: [string, string | null][]
  /** The version's metadata, for the collection's summary. */
  metadata: Record<string, unknown> | null
  pushedBy: string | null
  appId: string | null
  actorId: string | null
  pushSessionId: string | null
}

export type Landed =
  | { status: 'committed'; versionId: string; number: number; bump: 'major' | 'minor' | 'patch' }
  | { status: 'base_moved'; head: string | null }
  | { status: 'invalid'; problems: string[] }

export async function landCommit(ports: Ports, l: Landing): Promise<Landed> {
  const store = ports.stores.v3
  // Where landing's time goes, logged once it lands (timers advance across I/O).
  const at = [Date.now()]
  const mark = () => at.push(Date.now())
  await syncCatalog(ports, l.collectionId)
  mark()
  const head = await v3.findHead(store, l.collectionId)
  mark()
  if ((head?.id ?? null) !== l.expectHead) return { status: 'base_moved', head: head?.id ?? null }
  // Every file the change names is stored (its preparer installed it once checked).
  const files = l.change.files
  const absent = (
    await v3.inParallel(
      files.map((f) => async () => ((await store.head(v3.recordKey(f.id))) ? null : f.id)),
      16,
    )
  ).filter((x): x is string => x !== null)
  if (absent.length > 0) {
    return {
      status: 'invalid',
      problems: absent.slice(0, 20).map((id) => `File ${id} is not stored`),
    }
  }
  let stored: v3.StoredCommit
  try {
    stored = await v3.createCommit(
      store,
      l.collectionId,
      { change: l.change, bump: l.bump, ...(head ? { baseNumber: head.commit.number } : {}) },
      { signer: await ports.signer(), attempts: 1 },
    )
  } catch (err) {
    if (err instanceof v3.BaseError) return { status: 'invalid', problems: [err.message] }
    if (err instanceof v3.CommitRaceError) {
      const now = await v3.findHead(store, l.collectionId)
      return { status: 'base_moved', head: now?.id ?? null }
    }
    throw err
  }
  mark()
  const before = await lastRow(ports, l.collectionId)
  const version = await recordCommit(ports, {
    collectionId: l.collectionId,
    stored,
    stats: applyStats(before ? statsOfRow(before) : emptyStats(), l.stats),
    changes: l.stats.changes,
    schemaChanges: new Map(l.schemaChanges),
    metadata: l.metadata,
    pushedBy: l.pushedBy,
    appId: l.appId,
    actorId: l.actorId,
    pushSessionId: l.pushSessionId,
  })
  mark()
  await ports.jobs.enqueue({
    type: 'version.published',
    versionId: version.id,
    bump: l.bump,
  })
  mark()
  const step = (i: number) => at[i + 1]! - at[i]!
  // The upload's own copies, now stored under their ids: cleared (the sweep would, a day on).
  await v3.inParallel(
    files.map((f) => () => store.delete(v3.uploadKey(l.session, f.id))),
    16,
  )
  console.log(
    `[v3.land] ${l.collectionId} #${stored.commit.number}: sync ${step(0)}ms, head ${step(1)}ms, commit ${step(2)}ms, record ${step(3)}ms, queue ${step(4)}ms`,
  )
  return {
    status: 'committed',
    versionId: version.id,
    number: stored.commit.number,
    bump: l.bump,
  }
}
