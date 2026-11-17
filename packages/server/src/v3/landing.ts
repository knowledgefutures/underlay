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
import { createObject, v3 } from '@underlay/protocol'
import { and, eq, isNull } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { authorityIn, ensureCollection, notAuthority, writeReceiptFor } from './authority.js'
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
  /** Each file's session, when they came in several (a large client-built upload's copies). */
  sessions?: Record<string, string>
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
  /**
   * A commit its author built (protocol-v3 4.6): stored unchanged if it follows the head,
   * never renumbered. Its text, and when it was asked for (its `createdAt` is checked
   * against that).
   */
  authored?: { commit: string; receivedAt: string }
}

export type Landed =
  | { status: 'committed'; versionId: string; number: number; bump: 'major' | 'minor' | 'patch' }
  | { status: 'base_moved'; head: string | null }
  | { status: 'invalid'; problems: string[] }

const enc = new TextEncoder()

/**
 * Store an author-built commit unchanged, if it is the next one: created only if absent,
 * so of two authors who built on the same head, one wins and the other is told to replay.
 */
async function storeAuthored(
  ports: Ports,
  l: Landing,
  head: v3.StoredCommit | null,
  baseNumber: number | undefined,
): Promise<v3.StoredCommit | Landed> {
  const store = ports.stores.v3
  const bytes = enc.encode(l.authored!.commit)
  const checked = v3.checkAuthorCommit(bytes, l.collectionId, {
    head,
    files: l.change.files,
    bump: l.bump,
    now: new Date(l.authored!.receivedAt),
  })
  if ('stale' in checked) return { status: 'base_moved', head: head?.id ?? null }
  if ('problem' in checked) return { status: 'invalid', problems: [checked.problem] }
  // Its base is a version of this collection, as for a commit built here (`createCommit`):
  // a commit is stored for good, and a log holding one with any other base never verifies.
  const base = checked.commit.changes[0]!.base
  if (base !== null) {
    const at = !head
      ? null
      : head.id === base
        ? head.commit.number
        : await v3.findVersion(store, l.collectionId, base, head.commit.number, {
            ...(baseNumber === undefined ? {} : { hint: baseNumber }),
          })
    if (at === null)
      return { status: 'invalid', problems: [`Base ${base} is not a version of ${l.collectionId}`] }
  }
  const won = await createObject(
    store,
    v3.commitKey(l.collectionId, checked.commit.number),
    bytes,
    {
      contentType: 'application/json',
    },
  )
  if (!won) {
    const now = await v3.findHead(store, l.collectionId)
    return { status: 'base_moved', head: now?.id ?? null }
  }
  await v3.writeCommitHint(store, l.collectionId, checked.commit.number)
  return { commit: checked.commit, id: checked.id, bytes }
}

/** The upload's own copies of a change's files, now stored under their ids: cleared. */
const clearCopies = (ports: Ports, l: Landing) =>
  v3.inParallel(
    l.change.files.map(
      (f) => () => ports.stores.v3.delete(v3.uploadKey(l.sessions?.[f.id] ?? l.session, f.id)),
    ),
    16,
  )

/**
 * An author-built commit that is already the head: a land stored it and stopped before it
 * was recorded (the process ended, a write failed), and this is that land run again. The
 * commit is the one sent, byte for byte, so it landed: what the first run left undone is
 * done here. `syncCatalog` has written its row from the files; the row is given who pushed
 * it, and what it changed where that was counted against the head before it.
 */
async function landedBefore(ports: Ports, l: Landing, head: v3.StoredCommit): Promise<Landed> {
  await writeReceiptFor(ports, l.collectionId, head)
  const [row] = await ports.db
    .select()
    .from(schema.versions)
    .where(
      and(
        eq(schema.versions.collectionId, l.collectionId),
        eq(schema.versions.seq, head.commit.number),
      ),
    )
    .limit(1)
  if (!row) throw new Error(`Commit ${head.commit.number} of ${l.collectionId} has no row`)
  if (row.pushSessionId === null) {
    await ports.db
      .update(schema.versions)
      .set({
        pushedBy: l.pushedBy,
        appId: l.appId,
        actorId: l.actorId,
        pushSessionId: l.pushSessionId,
        // Counted against the head it was prepared on; that is the commit before only then.
        ...(l.expectHead === head.commit.previous ? { changes: l.stats.changes } : {}),
      })
      .where(and(eq(schema.versions.id, row.id), isNull(schema.versions.pushSessionId)))
    await ports.jobs.enqueue({ type: 'version.published', versionId: row.id, bump: l.bump })
  }
  await clearCopies(ports, l)
  console.log(`[v3.land] ${l.collectionId} #${head.commit.number}: landed before, finished now`)
  return { status: 'committed', versionId: row.id, number: head.commit.number, bump: l.bump }
}

export async function landCommit(ports: Ports, l: Landing): Promise<Landed> {
  const store = ports.stores.v3
  // Where landing's time goes, logged once it lands (timers advance across I/O).
  const at = [Date.now()]
  const mark = () => at.push(Date.now())
  await syncCatalog(ports, l.collectionId)
  mark()
  const [head, description] = await Promise.all([
    v3.findHead(store, l.collectionId),
    v3.readDescription(store, l.collectionId),
  ])
  mark()
  // Only a collection's authority accepts a version (protocol-v3 4.6), however it is sent.
  const authority = authorityIn(ports, description)
  if (authority !== ports.serverName)
    return { status: 'invalid', problems: [notAuthority(authority)] }
  // Its description, from its first commit however that is sent (an upload wrote none).
  if (!description) await ensureCollection(store, l.collectionId)
  if (l.authored && head && head.id === v3.versionId(enc.encode(l.authored.commit)))
    return landedBefore(ports, l, head)
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
  // Where the change's base is in the log, from D1: the library looks back only so far for a
  // base it is given no number for, and a commit is never refused for an old base.
  const [base] =
    l.change.base === null
      ? []
      : await ports.db
          .select({ seq: schema.versions.seq })
          .from(schema.versions)
          .where(
            and(
              eq(schema.versions.collectionId, l.collectionId),
              eq(schema.versions.hash, l.change.base),
            ),
          )
  const baseNumber = base?.seq ?? head?.commit.number
  let stored: v3.StoredCommit
  if (l.authored) {
    const out = await storeAuthored(ports, l, head, base?.seq)
    if ('status' in out) return out
    stored = out
  } else
    try {
      stored = await v3.createCommit(
        store,
        l.collectionId,
        { change: l.change, bump: l.bump, ...(baseNumber ? { baseNumber } : {}) },
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
  await writeReceiptFor(ports, l.collectionId, stored)
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
  await clearCopies(ports, l)
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
