/**
 * Landing a commit: the short last step of every v3 commit, the one that runs one at a
 * time for a collection (decision 4). Everything heavy happens before it, in the job that
 * prepares the change: building the files, looking up what each row replaces, verifying.
 * Landing then:
 *
 *   1. brings D1 up to the log (`syncCatalog`), and checks the head is still the one the
 *      change was prepared against; if not, the caller prepares again;
 *   2. checks and creates the commit (`commitUpload`, with no retries: a lost number means
 *      another commit landed, so the counts made against the old head no longer hold);
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
  /** The upload session the change's files are in. */
  session: string
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
  await syncCatalog(ports, l.collectionId)
  const head = await v3.findHead(store, l.collectionId)
  if ((head?.id ?? null) !== l.expectHead) return { status: 'base_moved', head: head?.id ?? null }
  let stored: v3.StoredCommit & { check: v3.UploadCheck }
  try {
    stored = await v3.commitUpload(
      store,
      l.collectionId,
      { change: l.change, ...(head ? { baseNumber: head.commit.number } : {}) },
      {
        session: l.session,
        signer: await ports.signer(),
        // The server built and checked these files itself, row by row, as they arrived.
        verify: false,
        validateRows: false,
        attempts: 1,
      },
    )
  } catch (err) {
    if (err instanceof v3.UploadError) return { status: 'invalid', problems: err.problems }
    if (err instanceof v3.CommitRaceError) {
      const now = await v3.findHead(store, l.collectionId)
      return { status: 'base_moved', head: now?.id ?? null }
    }
    throw err
  }
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
  await ports.jobs.enqueue({
    type: 'version.published',
    versionId: version.id,
    bump: stored.check.bump,
  })
  return {
    status: 'committed',
    versionId: version.id,
    number: stored.commit.number,
    bump: stored.check.bump,
  }
}
