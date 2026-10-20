/**
 * Uploads into a layout F collection write their records straight into packs of
 * the collection's, where they stay. Each record's run entry then carries its
 * place (`l`) instead of its body, so compaction moves entries of about 150 bytes
 * instead of whole records (a 30M-record Crossref session spent 10.5 hours
 * compacting 206 GB, 2026-10-19), and commit units index the records without
 * reading or writing them again.
 *
 * A pack is outside the collection's index and manifest until a commit names it
 * (`adoptSessionPacks`, just before the version publishes). Each is recorded in
 * `push_packs` before it's written, so storage cleanup can delete the packs of a
 * push that never published (`dropSessionPacks`).
 */
import {
  packIdsFor,
  type PackInfo,
  type RecordSet,
  type RecordSets,
  type Repo,
} from '@underlay/protocol'
import { and, eq, isNotNull } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { type RunEntry, runKey } from './runs.js'

const SETS = ['public', 'private'] as const

/** A pack an upload wrote, for its row's stats. */
export interface UploadPack {
  set: RecordSet
  pack: PackInfo
}

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
): Promise<UploadPack[]> {
  const last = new Map<string, RunEntry>()
  for (const e of entries) last.set(runKey(e), e)
  const out: UploadPack[] = []
  for (const set of SETS) {
    // An upload marks an entry private exactly when it goes to the private set (deltaChanges).
    const group = [...last.values()].filter((e) => (e.p === true) === (set === 'private'))
    if (!group.length) continue
    const recs = group.map((e) => ({ type: e.t, id: e.k, hash: e.h!, line: e.b! }))
    const ids = packIdsFor(recs)
    // Recorded before they're written: an upload that dies leaves no pack cleanup can't find.
    await ports.db
      .insert(schema.pushPacks)
      .values(ids.map((packId) => ({ sessionId, packId, set })))
    const { places, packs } = await records[set].writePacks!(recs, ids)
    group.forEach((e, i) => {
      e.l = places[i]!
      delete e.b
    })
    out.push(...packs.map((pack) => ({ set, pack })))
  }
  return out
}

/** The statements that record written packs' stats (run with the upload's run row). */
export const packStats = (ports: Ports, sessionId: string, packs: UploadPack[]) =>
  packs.map(({ pack }) =>
    ports.db
      .update(schema.pushPacks)
      .set({ records: pack.records, bytes: pack.bytes, raw: pack.raw })
      .where(and(eq(schema.pushPacks.sessionId, sessionId), eq(schema.pushPacks.packId, pack.id))),
  )

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
      .map((r) => ({ id: r.packId, tier: 0, records: r.records!, bytes: r.bytes!, raw: r.raw! }))
    if (packs.length) await repo.records[set].adoptPacks!(sessionId, packs)
  }
}

/**
 * At storage cleanup, settle a finished session's packs, then drop its rows:
 * - a version names the session: its commit listed them, nothing to do;
 * - no commit of it ever started: nothing indexes their records, so they're deleted;
 * - a commit started and never published: its index may name their records (one the
 *   collection already held, say, whose newest place is now such a pack), so they're
 *   listed instead, and reclaim drops what no version uses.
 * Returns the objects and bytes deleted (a pack is two objects), counting packs that
 * were written. A collection whose repository won't open (deleted) is left to the
 * sweep, which drops its files.
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
  if (!published && repo?.records) {
    if (session.commitStarted) {
      if (!dryRun) await adoptSessionPacks(ports, repo, session.id)
    } else {
      for (const set of SETS) {
        const mine = rows.filter((r) => r.set === set)
        if (!mine.length) continue
        // Refused if a commit listed them after all (KeyedLayout.dropPacks).
        const dropped =
          dryRun ||
          (await repo.records[set].dropPacks!(
            session.id,
            mine.map((r) => r.packId),
          ))
        if (!dropped) continue
        // A row without stats is a pack never written, or one whose upload died writing it.
        for (const r of mine)
          if (r.records !== null) {
            gone.objects += 2
            gone.bytes += r.bytes ?? 0
          }
      }
    }
  }
  if (!dryRun)
    await ports.db.delete(schema.pushPacks).where(eq(schema.pushPacks.sessionId, session.id))
  return gone
}
