/**
 * The change streams a delta session feeds the commit engine, per set and type,
 * shared by the serial commit (delta.ts) and the units of a parallel commit
 * (parallel.ts).
 */
import { type Change, type RecordEntry } from '@underlay/protocol'

import type { BlobStore } from '../ports.js'
import type { SetName } from '../versions/file-refs.js'
import { mergeRuns, type RunEntry, type RunIndex } from './runs.js'

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
 * The changes one set of a type gets from a delta session's runs, optionally
 * limited to a key range (a commit unit). An upsert goes to its set and becomes
 * a delete in the other set (when that set has a tree for the type); a delete
 * goes to both.
 */
export async function* deltaChanges(
  internal: BlobStore,
  sessionId: string,
  runs: RunIndex[],
  slug: string,
  set: SetName,
  privateType: boolean,
  base: BaseSets,
  range?: { after: string | null; through: string | null },
): AsyncGenerator<Change<RecordEntry>> {
  const inBase = set === 'public' ? base.pub : base.priv
  for await (const e of mergeRuns(internal, sessionId, runs, { type: slug, ...range })) {
    if (e.x) {
      if (inBase) yield { key: e.k, entry: null }
      continue
    }
    const target = privateType || e.p ? 'private' : 'public'
    if (target === set) yield { key: e.k, entry: toRecordEntry(e) }
    else if (inBase) yield { key: e.k, entry: null }
  }
}
