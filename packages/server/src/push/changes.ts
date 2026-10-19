/**
 * The change streams a delta session feeds the commit engine, per set and type,
 * shared by the serial commit (delta.ts) and the units of a parallel commit
 * (parallel.ts).
 */
import {
  type Change,
  gzip,
  keys,
  outOfLineHash,
  outOfLinePointer,
  type RecordEntry,
  type Repo,
  type SetName,
} from '@underlay/protocol'

import type { Store } from '../ports.js'
import { mergeRuns, type RunEntry, type RunIndex } from './runs.js'

/*
 * Large records (over OUT_OF_LINE_BYTES) are staged in the session's internal
 * area at upload, and their run entries carry the pointer. The commit puts each
 * into the repository as it takes the entry: inside the commit's write phase,
 * under its storage fence (cleanup/fence.ts). Written to the repository at
 * upload instead, a record could be swept while the session was still open and
 * the commit would point at nothing.
 */
const stagedKey = (sessionId: string, hash: string) =>
  `sessions/${sessionId}/records/${hash}.json.gz`

/** Stage a large record for a session; returns the body line its run entry carries. */
export async function stageOutOfLine(
  internal: Store,
  sessionId: string,
  hash: string,
  canonical: string,
): Promise<string> {
  await internal.put(stagedKey(sessionId, hash), await gzip(canonical), {
    contentType: 'application/gzip',
  })
  return outOfLinePointer(hash)
}

/** Put a staged large record into the repository (an entry with an inline body needs nothing). */
export async function takeStaged(
  internal: Store,
  repo: Repo,
  sessionId: string,
  body: string | undefined,
): Promise<void> {
  const hash = body ? outOfLineHash(body) : null
  if (!hash) return
  const staged = await internal.get(stagedKey(sessionId, hash))
  if (staged) {
    await repo.blobs.put(keys.record(hash), await staged.bytes(), {
      contentType: 'application/gzip',
      ifAbsent: true,
    })
  } else if (!(await repo.blobs.head(keys.record(hash)))) {
    // Sessions from before staging wrote the record straight to the repository.
    throw new Error(`Large record ${hash} was never staged; push it again`)
  }
}

export const isPrivateSchema = (s: Record<string, unknown>) => s.private === true

export const toRecordEntry = (e: RunEntry): RecordEntry => ({
  key: e.k,
  hash: e.h!,
  size: e.s!,
  body: e.b!,
})

/** Which sets of a type the base has a tree in. */
export interface BaseSets {
  pub: boolean
  priv: boolean
}

/**
 * Large records taken from staging ahead of the merge. Each is a read and a
 * write; taken one at a time, a unit over a range of them spent its wall clock
 * on R2's latency (staging, 2026-10-17: 15 s of CPU in 15 minutes). At most
 * `entries` changes wait behind a record being taken, and reading ahead
 * stops once `bytes` of large records (their raw size) are waiting.
 */
export const takeAheadConfig = { entries: 16, bytes: 8 * 1024 * 1024 }

/**
 * The changes one set of a type gets from a delta session's runs, optionally
 * limited to a key range (a commit unit). An upsert goes to its set and becomes
 * a delete in the other set (when that set has a tree for the type); a delete
 * goes to both.
 */
export async function* deltaChanges(
  internal: Store,
  repo: Repo,
  sessionId: string,
  runs: RunIndex[],
  slug: string,
  set: SetName,
  privateType: boolean,
  base: BaseSets,
  range?: { after: string | null; through: string | null },
): AsyncGenerator<Change<RecordEntry>> {
  const inBase = set === 'public' ? base.pub : base.priv
  // Changes in key order. A large record's has `taken` until its take settles.
  const ahead: { change: Change<RecordEntry>; taken?: Promise<void> | undefined; bytes: number }[] =
    []
  let takingBytes = 0
  const next = async () => {
    const a = ahead.shift()!
    await a.taken
    takingBytes -= a.bytes
    return a.change
  }
  for await (const e of mergeRuns(internal, sessionId, runs, { type: slug, ...range })) {
    if (e.x) {
      if (inBase) ahead.push({ change: { key: e.k, entry: null }, bytes: 0 })
    } else if ((privateType || e.p ? 'private' : 'public') === set) {
      const change = { key: e.k, entry: toRecordEntry(e) }
      if (e.b && outOfLineHash(e.b)) {
        const a: (typeof ahead)[number] = { change, bytes: e.s ?? 0 }
        a.taken = takeStaged(internal, repo, sessionId, e.b).then(() => {
          a.taken = undefined
        })
        // Awaited in order by `next`; this only keeps an early failure from going unhandled.
        a.taken.catch(() => {})
        ahead.push(a)
        takingBytes += a.bytes
      } else ahead.push({ change, bytes: 0 })
    } else if (inBase) ahead.push({ change: { key: e.k, entry: null }, bytes: 0 })
    while (
      ahead.length > 0 &&
      (!ahead[0]!.taken ||
        ahead.length >= takeAheadConfig.entries ||
        takingBytes >= takeAheadConfig.bytes)
    )
      yield await next()
  }
  while (ahead.length > 0) yield await next()
}
