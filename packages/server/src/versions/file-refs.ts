/**
 * Keeping each set's file tree right in O(changes) (edge-redesign-build.md,
 * finding 5).
 *
 * Protocol (docs/protocol-v2.md §9): a file belongs to every set that has a
 * record referencing it; a file declared in a push but referenced by no record
 * belongs to the private set. To know when a file leaves a set, each set keeps a
 * sidecar count tree (not protocol) next to the version:
 *
 *   "r:<fileHash>" → how many of the set's records reference the file
 *   "d:<fileHash>" → 1 when the file is declared (private set only)
 *
 * A commit turns record changes into count deltas, applies them to the count
 * tree, and adds or removes files from the protocol file tree only when a file's
 * presence actually flips.
 */
import {
  type Change,
  compareUtf8,
  type CountEntry,
  countTree,
  type FileEntry,
  fileRefs,
  fileTree,
  getEntry,
  iterate,
  mergeTree,
  type RecordEntry,
  type Repo,
  RepoSink,
  RepoSource,
  type TreeSummary,
} from '@underlay/protocol'
import { inArray } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export type SetName = 'public' | 'private'

const REF = 'r:'
const DECLARED = 'd:'

/** Accumulates reference count changes from record changes, per set. */
export class FileRefDelta {
  readonly refs: Record<SetName, Map<string, number>> = { public: new Map(), private: new Map() }

  #bump(set: SetName, hashes: string[], by: number) {
    const m = this.refs[set]
    for (const h of hashes) m.set(h, (m.get(h) ?? 0) + by)
  }

  /** Feed one record change in a set (mergeTree's onChange). */
  record(set: SetName, before: RecordEntry | null, after: RecordEntry | null): void {
    if (before) this.#bump(set, refsOfBody(before.body), -1)
    if (after) this.#bump(set, refsOfBody(after.body), +1)
  }

  get touched(): boolean {
    return [...this.refs.public.values(), ...this.refs.private.values()].some((n) => n !== 0)
  }
}

function refsOfBody(body: string | undefined): string[] {
  if (body === undefined) throw new Error('File reference accounting needs record bodies')
  // Cheap prefilter: most records reference no files.
  if (!body.includes('"$file"')) return []
  return fileRefs((JSON.parse(body) as { data: unknown }).data)
}

export interface FileSetResult {
  files: TreeSummary
  refsRoot: string | null
  /** Files that entered the set in this commit (for the cumulative public files tree). */
  added: string[]
}

export class MissingFilesError extends Error {
  constructor(readonly hashes: string[]) {
    super(`${hashes.length} referenced file(s) are not uploaded`)
    this.name = 'MissingFilesError'
  }
}

/** File sizes for hashes, from the files table (chunked for D1's bound-parameter limit). */
export async function fileSizes(db: Db, hashes: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < hashes.length; i += 90) {
    const rows = await db
      .select({ hash: schema.files.hash, size: schema.files.size })
      .from(schema.files)
      .where(inArray(schema.files.hash, hashes.slice(i, i + 90)))
    for (const r of rows) out.set(r.hash, r.size)
  }
  return out
}

/** The declared-file markers currently in a count tree. O(declared files). */
export async function declaredFiles(repo: Repo, refsRoot: string | null): Promise<Set<string>> {
  const out = new Set<string>()
  for await (const e of iterate(new RepoSource(countTree, repo), refsRoot, { after: DECLARED })) {
    if (!e.key.startsWith(DECLARED)) break
    out.add(e.key.slice(DECLARED.length))
  }
  return out
}

/**
 * Apply a set's reference deltas (and, for the private set, declared-file
 * changes) to its count tree and file tree.
 */
export async function applyFileSet(
  db: Db,
  repo: Repo,
  base: { refsRoot: string | null; files: TreeSummary },
  refDeltas: Map<string, number>,
  declared: { add: string[]; remove: string[] } | null,
): Promise<FileSetResult> {
  const counts = new RepoSource(countTree, repo)
  const keyDelta = new Map<string, number>()
  for (const [h, d] of refDeltas) if (d !== 0) keyDelta.set(REF + h, d)
  for (const h of declared?.add ?? [])
    keyDelta.set(DECLARED + h, (keyDelta.get(DECLARED + h) ?? 0) + 1)
  for (const h of declared?.remove ?? [])
    keyDelta.set(DECLARED + h, (keyDelta.get(DECLARED + h) ?? 0) - 1)
  if ([...keyDelta.values()].every((d) => d === 0)) {
    return { files: base.files, refsRoot: base.refsRoot, added: [] }
  }

  // New counts, and whether each touched file is present before and after.
  const countChanges: Change<CountEntry>[] = []
  const presence = new Map<string, { before: boolean; after: boolean }>()
  const hashesTouched = new Set([...keyDelta.keys()].map((k) => k.slice(2)))
  for (const h of hashesTouched) {
    const p = { before: false, after: false }
    for (const prefix of [REF, DECLARED]) {
      const key = prefix + h
      const old = (await getEntry(counts, base.refsRoot, key))?.n ?? 0
      const now = old + (keyDelta.get(key) ?? 0)
      if (prefix === REF && now < 0) throw new Error(`File reference count for ${h} went negative`)
      // Declaring is idempotent: a marker is 0 or 1.
      const n = prefix === DECLARED ? Math.min(1, Math.max(0, now)) : now
      if (n !== old) countChanges.push({ key, entry: n > 0 ? { key, n } : null })
      p.before ||= old > 0
      p.after ||= n > 0
    }
    presence.set(h, p)
  }
  countChanges.sort((a, b) => compareUtf8(a.key, b.key))

  const entering = [...presence].filter(([, p]) => !p.before && p.after).map(([h]) => h)
  const leaving = [...presence].filter(([, p]) => p.before && !p.after).map(([h]) => h)
  const sizes = await fileSizes(db, entering)
  const missing = entering.filter((h) => !sizes.has(h))
  if (missing.length > 0) throw new MissingFilesError(missing)

  const fileChanges: Change<FileEntry>[] = [
    ...entering.map((h) => ({ key: h, entry: { key: h, size: sizes.get(h)! } })),
    ...leaving.map((h) => ({ key: h, entry: null })),
  ].sort((a, b) => compareUtf8(a.key, b.key))

  const sink = new RepoSink<CountEntry>(repo)
  const refs = await mergeTree(counts, sink, base.refsRoot, countChanges)
  const fileSink = new RepoSink<FileEntry>(repo)
  const files = await mergeTree(
    new RepoSource(fileTree, repo),
    fileSink,
    base.files.root,
    fileChanges,
  )
  await Promise.all([sink.flush(), fileSink.flush()])
  return {
    refsRoot: refs.root?.hash ?? null,
    files: files.root
      ? { root: files.root.hash, count: files.root.count, bytes: files.root.bytes }
      : { root: null, count: 0, bytes: 0 },
    added: entering,
  }
}
