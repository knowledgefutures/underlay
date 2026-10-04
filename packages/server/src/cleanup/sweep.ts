/**
 * Cleanup step 3: sweep (planning: v2-storage-cleanup.md). List the platform
 * bucket area by area, keep what the mark (or a row) says is in use, and delete
 * the rest inside short deletion windows behind the write fence.
 *
 * Only these key shapes are ever deleted; anything else is kept and counted as
 * unknown:
 *
 *   repository   nodes/<hash>, bodies/<hash>.ndjson.gz, records/<hash>.json.gz,
 *                roots/<digest>.json, private/<commitment>.json: unmarked
 *                files/<hash>: unmarked, with its `files` row
 *                collections/<id>/…: no collection row, no tombstone in grace
 *   internal     sessions/<id>/…: no push session row, past the orphan age
 *                (reference-log scratch, sessions/refs-…, is step 1's)
 *                uploads/<id>: no upload row, or one that's done, past the orphan age
 *
 * Repository objects also have to be older than MIN_AGE_MS, so a write phase in
 * progress is never the reason for a redo. Schemas, v1 file keys outside the
 * repository, the reference log and usage logs are never touched.
 *
 * Each deletion window: wait until no push is committing (a parallel commit
 * can't redo its units), re-mark from versions published since the mark began
 * (once before the window, so writers wait as little as possible, and again
 * inside it), delete `files` rows, then objects, checking the window's deadline
 * as it goes, and close it.
 */
import type { Store } from '@underlay/protocol'
import { and, asc, eq, gt, gte, inArray, or } from 'drizzle-orm'

import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { cleanupConfig, count, emptyStats } from './config.js'
import { closeWindow, openWindow, type Window, windowStillOpen } from './fence.js'
import { graceCutoff, markRepo, possessionHeld } from './mark.js'
import { Marker, type MarkSet } from './marks.js'

/** Repository objects younger than this are never deleted (a write phase may be using them). */
export const MIN_AGE_MS = 60 * 60 * 1000
/** Re-marks also cover versions published this long before the mark began (writes that follow a publish). */
const REMARK_SLACK_MS = 60 * 60 * 1000

export const AREAS = [
  { store: 'repo', prefix: 'nodes/' },
  { store: 'repo', prefix: 'bodies/' },
  { store: 'repo', prefix: 'records/' },
  { store: 'repo', prefix: 'roots/' },
  { store: 'repo', prefix: 'private/' },
  { store: 'repo', prefix: 'files/' },
  { store: 'repo', prefix: 'collections/' },
  { store: 'internal', prefix: 'sessions/' },
  { store: 'internal', prefix: 'uploads/' },
] as const

export interface SweepState {
  /** Index into AREAS, and the listing cursor within it. */
  area: number
  cursor: string | null
  /** When the mark began. */
  markStartedAt: number
}

const HEX64 = /^[0-9a-f]{64}$/

export interface ParsedKey {
  kind: string
  /** The hash the mark holds for it (content-addressed kinds). */
  token?: string
  /** The row it belongs to (collections, sessions, uploads). */
  owner?: string
}

/** What a listed key is, or null for a shape the sweep never deletes. */
export function parseKey(prefix: string, key: string): ParsedKey | null {
  const rest = key.slice(prefix.length)
  const hashed = (kind: string, suffix: string): ParsedKey | null => {
    if (!rest.endsWith(suffix)) return null
    const h = rest.slice(0, rest.length - suffix.length)
    return HEX64.test(h) ? { kind, token: h } : null
  }
  const owned = (kind: string, needsMore: boolean): ParsedKey | null => {
    const slash = rest.indexOf('/')
    const id = slash < 0 ? rest : rest.slice(0, slash)
    if (!id || (needsMore ? slash < 0 : slash >= 0)) return null
    return { kind, owner: id }
  }
  switch (prefix) {
    case 'nodes/':
      return hashed('nodes', '')
    case 'bodies/':
      return hashed('bodies', '.ndjson.gz')
    case 'records/':
      return hashed('records', '.json.gz')
    case 'roots/':
      return hashed('roots', '.json')
    case 'private/':
      return hashed('private', '.json')
    case 'files/':
      return hashed('files', '')
    case 'collections/':
      return owned('collections', true)
    case 'sessions/': {
      const p = owned('sessions', true)
      return p && !p.owner!.startsWith('refs-') ? p : null
    }
    case 'uploads/':
      return owned('uploads', false)
  }
  return null
}

interface Candidate {
  store: Store
  key: string
  kind: string
  token?: string
  owner?: string
  size: number
}

/** The candidates on one listed page: what nothing seems to use. */
async function classify(
  ports: Ports,
  marks: MarkSet,
  store: Store,
  prefix: string,
  page: { keys: string[]; info?: { size: number; modified: number }[] },
  stats: schema.CleanupStats,
): Promise<Candidate[]> {
  const { db } = ports
  const now = Date.now()
  const out: Candidate[] = []
  const owned: Candidate[] = []
  page.keys.forEach((key, i) => {
    const p = parseKey(prefix, key)
    if (!p) {
      if (!(prefix === 'sessions/' && key.startsWith('sessions/refs-'))) stats.unknown++
      return
    }
    const info = page.info?.[i]
    // No write time: can't tell its age, so it stays.
    if (!info) return
    const age = now - info.modified
    const minAge =
      p.kind === 'sessions' || p.kind === 'uploads' ? cleanupConfig.orphanAgeMs : MIN_AGE_MS
    if (age < minAge) return
    const c: Candidate = { store, key, kind: p.kind, size: info.size }
    if (p.token) {
      if (!marks.has(p.token)) out.push({ ...c, token: p.token })
    } else owned.push({ ...c, owner: p.owner! })
  })
  if (owned.length === 0) return out

  const ids = [...new Set(owned.map((c) => c.owner!))]
  const kept = new Set<string>()
  for (const part of chunks(ids)) {
    const kind = owned[0]!.kind
    if (kind === 'collections') {
      for (const id of await collectionsInUse(ports, part)) kept.add(id)
    } else if (kind === 'sessions') {
      const rows = await db
        .select({ id: schema.pushSessions.id })
        .from(schema.pushSessions)
        .where(inArray(schema.pushSessions.id, part))
      for (const r of rows) kept.add(r.id)
    } else {
      const rows = await db
        .select({ id: schema.fileUploads.id, status: schema.fileUploads.status })
        .from(schema.fileUploads)
        .where(inArray(schema.fileUploads.id, part))
      // A pending or verifying upload's staging object is in use (step 1 handles the abandoned).
      for (const r of rows) if (r.status === 'pending' || r.status === 'verifying') kept.add(r.id)
    }
  }
  for (const c of owned) if (!kept.has(c.owner!)) out.push(c)
  return out
}

/** Of these collection ids, those with a row, or a tombstone still in its grace period. */
async function collectionsInUse(ports: Ports, ids: string[]): Promise<string[]> {
  const [live, recent] = await Promise.all([
    ports.db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(inArray(schema.collections.id, ids)),
    ports.db
      .select({ id: schema.collectionTombstones.collectionId })
      .from(schema.collectionTombstones)
      .where(
        and(
          inArray(schema.collectionTombstones.collectionId, ids),
          gt(schema.collectionTombstones.deletedAt, graceCutoff()),
        ),
      ),
  ])
  return [...live, ...recent].map((r) => r.id)
}

/**
 * Re-mark what changed since the mark began: versions published since (their
 * trees and refs trees), collections whose public files tree moved, and
 * possessions of the candidate files.
 */
async function remark(
  ports: Ports,
  marks: MarkSet,
  markStartedAt: number,
  candidates: Candidate[],
): Promise<void> {
  const { db } = ports
  const since = new Date(markStartedAt - REMARK_SLACK_MS)
  const marker = new Marker(await markRepo(ports), marks)
  let after: { at: Date; id: string } | null = null
  for (;;) {
    const rows: {
      id: string
      hash: string
      at: Date | null
      publicRefsRoot: string | null
      privateRefsRoot: string | null
    }[] = await db
      .select({
        id: schema.versions.id,
        hash: schema.versions.hash,
        at: schema.versions.publishedAt,
        publicRefsRoot: schema.versions.publicRefsRoot,
        privateRefsRoot: schema.versions.privateRefsRoot,
      })
      .from(schema.versions)
      .where(
        after
          ? or(
              gt(schema.versions.publishedAt, after.at),
              and(eq(schema.versions.publishedAt, after.at), gt(schema.versions.id, after.id)),
            )
          : gte(schema.versions.publishedAt, since),
      )
      .orderBy(asc(schema.versions.publishedAt), asc(schema.versions.id))
      .limit(200)
    for (const v of rows) {
      await marker.version(v.hash)
      await marker.counts(v.publicRefsRoot)
      await marker.counts(v.privateRefsRoot)
    }
    if (rows.length < 200) break
    const last = rows[rows.length - 1]!
    after = { at: last.at!, id: last.id }
  }
  let afterId: string | null = null
  for (;;) {
    const rows = await db
      .select({ id: schema.collections.id, root: schema.collections.publicFilesRoot })
      .from(schema.collections)
      .where(
        and(
          or(gte(schema.collections.updatedAt, since), gte(schema.collections.reconciledAt, since)),
          afterId ? gt(schema.collections.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(schema.collections.id))
      .limit(200)
    for (const c of rows) await marker.files(c.root)
    if (rows.length < 200) break
    afterId = rows[rows.length - 1]!.id
  }
  const files = candidates.filter((c) => c.kind === 'files').map((c) => c.token!)
  for (const part of chunks(files)) {
    const rows = await db
      .select({ hash: schema.fileUploads.hash })
      .from(schema.fileUploads)
      .where(
        and(
          eq(schema.fileUploads.status, 'verified'),
          inArray(schema.fileUploads.hash, part),
          possessionHeld(graceCutoff()),
        ),
      )
    for (const r of rows) marks.add(r.hash)
  }
}

/** Pushes committing now (recently started), which a deletion window would fail. */
async function committing(ports: Ports): Promise<boolean> {
  const [row] = await ports.db
    .select({ id: schema.pushSessions.id })
    .from(schema.pushSessions)
    .where(
      and(
        eq(schema.pushSessions.status, 'committing'),
        gt(
          schema.pushSessions.finalizeStartedAt,
          new Date(Date.now() - cleanupConfig.committingHoldMs),
        ),
      ),
    )
    .limit(1)
  return !!row
}

/**
 * Delete candidates in deletion windows (or, dry, count them). 'wait' when a
 * push is committing or another window is open: the caller tries again later.
 */
async function deleteCandidates(
  ports: Ports,
  runId: string,
  marks: MarkSet,
  markStartedAt: number,
  candidates: Candidate[],
  dryRun: boolean,
  stats: schema.CleanupStats,
): Promise<'ok' | 'wait'> {
  if (candidates.length === 0) return 'ok'
  // Outside a window: catch up on what was published since the mark, so the
  // re-mark inside the window is short.
  await remark(ports, marks, markStartedAt, candidates)
  const live = (c: Candidate) => !!c.token && marks.has(c.token)
  if (dryRun) {
    for (const c of candidates) if (!live(c)) count(stats, c.kind, c.size)
    return 'ok'
  }
  const { db } = ports
  for (let i = 0; i < candidates.length; i += cleanupConfig.windowObjects) {
    const group = candidates.slice(i, i + cleanupConfig.windowObjects)
    if (await committing(ports)) return 'wait'
    const w: Window | null = await openWindow(db, runId, cleanupConfig.windowMs)
    if (!w) return 'wait'
    try {
      stats.windows++
      await remark(ports, marks, markStartedAt, group)
      let doomed = group.filter((c) => !live(c))
      // A collection restored since it was listed has a row again.
      const owners = doomed.filter((c) => c.kind === 'collections').map((c) => c.owner!)
      if (owners.length) {
        const inUse = new Set<string>()
        for (const part of chunks([...new Set(owners)]))
          for (const id of await collectionsInUse(ports, part)) inUse.add(id)
        doomed = doomed.filter((c) => c.kind !== 'collections' || !inUse.has(c.owner!))
      }
      // Rows before bytes: a crash between leaves bytes nothing points to, never
      // a row pointing at nothing.
      const fileKeys = doomed
        .filter((c) => c.kind === 'files')
        .map((c) => ports.stores.canonicalFileKey(c.token!))
      // Past the window's deadline the rest waits for the next sweep.
      let open = true
      for (const part of chunks(fileKeys)) {
        if (!(open = await windowStillOpen(db, w))) break
        const gone = await db
          .delete(schema.files)
          .where(inArray(schema.files.storageKey, part))
          .returning({ hash: schema.files.hash })
        stats.rows += gone.length
      }
      for (let j = 0; open && j < doomed.length; j += cleanupConfig.deleteConcurrency) {
        if (!(open = await windowStillOpen(db, w))) break
        const part = doomed.slice(j, j + cleanupConfig.deleteConcurrency)
        await Promise.all(part.map((c) => c.store.delete(c.key)))
        for (const c of part) count(stats, c.kind, c.size)
      }
    } finally {
      await closeWindow(db, w)
    }
  }
  return 'ok'
}

/**
 * One sweep job: list pages from `state`, deleting as it goes, until the areas
 * are done, the page budget is spent, or it has to wait for pushes.
 */
export async function sweepStep(
  ports: Ports,
  runId: string,
  marks: MarkSet,
  state: SweepState,
  dryRun: boolean,
): Promise<{ state: SweepState; stats: schema.CleanupStats; outcome: 'more' | 'done' | 'wait' }> {
  const stats = emptyStats()
  const repo = await ports.stores.forLocation(schema.PLATFORM_LOCATION_ID)
  const stores = { repo: repo.blobs, internal: ports.stores.internal }
  let s = { ...state }
  // Where the candidates gathered so far began: a 'wait' lists them again.
  let start = { ...s }
  let pending: Candidate[] = []
  const flush = async () => {
    const r = await deleteCandidates(ports, runId, marks, s.markStartedAt, pending, dryRun, stats)
    pending = []
    return r
  }
  for (let pages = 0; s.area < AREAS.length && pages < cleanupConfig.sweepPages; pages++) {
    const area = AREAS[s.area]!
    const store = stores[area.store]
    const page = await store.list(area.prefix, s.cursor ?? undefined)
    stats.scanned += page.keys.length
    pending.push(...(await classify(ports, marks, store, area.prefix, page, stats)))
    const next = page.cursor
      ? { ...s, cursor: page.cursor }
      : { ...s, area: s.area + 1, cursor: null }
    if (pending.length >= cleanupConfig.windowObjects || next.area !== s.area) {
      if ((await flush()) === 'wait') return { state: start, stats, outcome: 'wait' }
      start = { ...next }
    }
    s = next
    const deleted = Object.values(stats.deleted).reduce((n, c) => n + c.objects, 0)
    if (deleted >= cleanupConfig.sweepDeletes) break
  }
  if ((await flush()) === 'wait') return { state: start, stats, outcome: 'wait' }
  return { state: s, stats, outcome: s.area >= AREAS.length ? 'done' : 'more' }
}
