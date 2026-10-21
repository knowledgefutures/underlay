/**
 * Uploads into a layout F collection write their records straight into packs of
 * the collection's, where they stay. Each record's run entry then carries its
 * place (`l`) instead of its body, so compaction moves entries of about 150 bytes
 * instead of whole records (a 30M-record Crossref session spent 10.5 hours
 * compacting 206 GB, 2026-10-19), and commit units index the records without
 * reading or writing them again.
 *
 * A session opened `in_key_order` (its uploads sorted by type and id) streams each
 * record into a pack as it arrives (`keyOrderPlacer`): packs fill to 16 MB, hold
 * neighbouring records, and a batch isn't held in memory, so batches can be larger.
 * Otherwise a batch is sorted and packed once it's read (`packEntries`), a pack a
 * batch, in whatever order the batches come.
 *
 * A pack is outside the collection's index and manifest until a commit names it
 * (`adoptSessionPacks`, just before the version publishes). Each is recorded in
 * `push_packs` before it's written and its stats once it is, so storage cleanup can
 * settle the packs of a push that never published (`settleSessionPacks`).
 */
import {
  type PackHooks,
  type PackInfo,
  type RecordSet,
  type RecordSets,
  type Repo,
  type UploadWriter,
} from '@underlay/protocol'
import { and, eq, isNotNull } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { compareRunKeys, type RunEntry, runKey } from './runs.js'

const SETS = ['public', 'private'] as const

/** An upload marks an entry private exactly when it goes to the private set (deltaChanges). */
const setOf = (e: RunEntry): RecordSet => (e.p ? 'private' : 'public')

/** A record key as SQLite text: JSON, since keys hold NULs and text stops at one. */
const keyText = (key: string | undefined) => (key === undefined ? undefined : JSON.stringify(key))

/** Each pack recorded before it's written, and its stats once it is. */
const hooksFor = (ports: Ports, sessionId: string, set: RecordSet): PackHooks => ({
  before: async (packId) => {
    await ports.db.insert(schema.pushPacks).values({ sessionId, packId, set })
  },
  after: async (pack) => {
    await ports.db
      .update(schema.pushPacks)
      .set({
        records: pack.records,
        bytes: pack.bytes,
        raw: pack.raw,
        recordType: pack.type,
        loKey: keyText(pack.lo),
        hiKey: keyText(pack.hi),
      })
      .where(and(eq(schema.pushPacks.sessionId, sessionId), eq(schema.pushPacks.packId, pack.id)))
  },
})

/**
 * Write a batch's records into packs, a set each, and give their entries places
 * instead of bodies. Within the batch the last entry of a key wins (writeRun),
 * so only those are written.
 */
export async function packEntries(
  ports: Ports,
  sessionId: string,
  records: RecordSets,
  entries: RunEntry[],
): Promise<void> {
  const last = new Map<string, RunEntry>()
  for (const e of entries) last.set(runKey(e), e)
  for (const set of SETS) {
    const group = [...last.values()].filter((e) => setOf(e) === set)
    if (!group.length) continue
    const recs = group.map((e) => ({ type: e.t, id: e.k, hash: e.h!, line: e.b! }))
    const { places } = await records[set].writePacks!(recs, hooksFor(ports, sessionId, set))
    group.forEach((e, i) => {
      e.l = places[i]!
      delete e.b
    })
  }
}

/** A record of a key-ordered upload that comes before the one ahead of it. */
export class OutOfKeyOrder extends Error {
  constructor(readonly line: number) {
    super(
      `Records out of key order at line ${line}: this session was opened in_key_order, so each batch's records go by type, then id`,
    )
  }
}

/**
 * Places a key-ordered batch's records as they arrive: each straight into its set's
 * pack, its entry left with a place instead of a body. `finish` writes the last
 * packs. A record before the one ahead of it throws OutOfKeyOrder.
 */
export function keyOrderPlacer(ports: Ports, sessionId: string, records: RecordSets) {
  const writers = new Map<RecordSet, UploadWriter>()
  let last: RunEntry | null = null
  let n = 0
  return {
    async place(e: RunEntry, line: number): Promise<void> {
      if (last && compareRunKeys(e, last) < 0) throw new OutOfKeyOrder(line)
      last = e
      const set = setOf(e)
      let w = writers.get(set)
      if (!w) {
        w = records[set].uploadWriter!(hooksFor(ports, sessionId, set))
        writers.set(set, w)
      }
      e.l = w.append({ type: e.t, id: e.k, hash: e.h!, line: e.b! })
      delete e.b
      if (++n % 256 === 0) await w.ready()
    },
    async finish(): Promise<void> {
      for (const w of writers.values()) await w.finish()
    },
  }
}

/**
 * List a session's packs in the collection's manifest or registry. Called once the
 * commit's index names their records, before its version publishes; a retry lists
 * nothing twice (KeyedLayout.adoptPacks).
 */
export async function adoptSessionPacks(ports: Ports, repo: Repo, sessionId: string) {
  if (!repo.records) return
  const rows = await ports.db
    .select()
    .from(schema.pushPacks)
    .where(and(eq(schema.pushPacks.sessionId, sessionId), isNotNull(schema.pushPacks.records)))
  for (const set of SETS) {
    const packs: PackInfo[] = rows
      .filter((r) => r.set === set)
      .map((r) => ({
        id: r.packId,
        tier: 0,
        records: r.records!,
        bytes: r.bytes!,
        raw: r.raw!,
        ...(r.recordType ? { type: r.recordType } : {}),
        ...(r.loKey && r.hiKey
          ? { lo: JSON.parse(r.loKey) as string, hi: JSON.parse(r.hiKey) as string }
          : {}),
      }))
    if (packs.length) await repo.records[set].adoptPacks!(sessionId, packs)
  }
}

/**
 * At storage cleanup, settle a finished session's packs, then drop its rows:
 * - a pack with no stats was never reported written, so no recorded run places a
 *   record in it: deleted, whatever became of the session;
 * - a version names the session: its commit listed the rest, nothing to do;
 * - no commit of it ever started: nothing indexes their records, so they're deleted;
 * - a commit started and never published: its index may name their records (one the
 *   collection already held, say, whose newest place is now such a pack), so they're
 *   listed instead, and reclaim drops what no version uses.
 * A pack the collection lists is never deleted here (KeyedLayout.dropPacks). Returns
 * the objects and bytes deleted (a pack is two objects). A collection whose
 * repository won't open (deleted) is left to the sweep, which drops its files.
 */
export async function settleSessionPacks(
  ports: Ports,
  session: { id: string; collectionId: string; commitStarted: boolean },
  dryRun: boolean,
): Promise<{ objects: number; bytes: number }> {
  const gone = { objects: 0, bytes: 0 }
  const rows = await ports.db
    .select()
    .from(schema.pushPacks)
    .where(eq(schema.pushPacks.sessionId, session.id))
  if (!rows.length) return gone
  const [published] = await ports.db
    .select({ id: schema.versions.id })
    .from(schema.versions)
    .where(eq(schema.versions.pushSessionId, session.id))
    .limit(1)
  let repo: Repo | null = null
  try {
    repo = await ports.stores.forCollection(session.collectionId)
  } catch {
    repo = null
  }
  if (repo?.records) {
    const keepWritten = !!published || session.commitStarted
    if (!published && session.commitStarted && !dryRun)
      await adoptSessionPacks(ports, repo, session.id)
    for (const set of SETS) {
      const drop = rows.filter((r) => r.set === set && (r.records === null || !keepWritten))
      if (!drop.length) continue
      const ids = dryRun
        ? drop.map((r) => r.packId)
        : await repo.records[set].dropPacks!(
            session.id,
            drop.map((r) => r.packId),
          )
      const dropped = new Set(ids)
      for (const r of drop)
        if (dropped.has(r.packId) && r.records !== null) {
          gone.objects += 2
          gone.bytes += r.bytes ?? 0
        }
    }
  }
  if (!dryRun)
    await ports.db.delete(schema.pushPacks).where(eq(schema.pushPacks.sessionId, session.id))
  return gone
}
