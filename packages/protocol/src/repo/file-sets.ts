/**
 * Keeping each set's file tree right in O(changes) (edge-redesign-build.md,
 * finding 5).
 *
 * Protocol (docs/protocol-v2.md §9): a file belongs to every set that has a
 * record referencing it; a file declared in a push but referenced by no record
 * belongs to the private set. To know when a file leaves a set, each set keeps a
 * sidecar count tree (not protocol, a writer's bookkeeping) next to the version:
 *
 *   "r:<fileHash>" → how many of the set's records reference the file
 *   "d:<fileHash>" → 1 when the file is declared (private set only)
 *   "t:<type>/<fileHash>" → how many of the set's records of that type reference it
 *   "m:types" → 1: this tree carries the "t:" keys
 *
 * The per-type counts let a type move between sets, or be removed, by moving
 * its counts: O(files the type references), with no record bodies read. Trees
 * written before them have no "m:types" marker; on those, moves and removals
 * read the type's bodies as before, until the tree is rebuilt (rebuildFileRefs).
 * A null tree (no references at all) needs no marker.
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
  recordTree,
  type SetObject,
  type TreeSummary,
} from '../format.js'
import { outOfLineHash, type Repo, RepoSink, RepoSource } from './repo.js'

export type SetName = 'public' | 'private'

const REF = 'r:'
const DECLARED = 'd:'
const TYPED = 't:'
const MARKER = 'm:types'

/** A per-type key's suffix: type slugs can't contain "/" (input rules). */
const typedKey = (type: string, hash: string) => `${type}/${hash}`

/**
 * Accumulates reference count changes from record changes, per set.
 *
 * A record stored out of line arrives as a pointer line when a writer adds it
 * (its body isn't in hand) but as its full body when a reader hands it back.
 * Pointers are counted by record hash here and turned into file references by
 * `resolve`, which must run before `refs` is used.
 */
export class FileRefDelta {
  /** Per set: file hash → change in references. */
  readonly refs: Record<SetName, Map<string, number>> = { public: new Map(), private: new Map() }
  /** Per set: "<type>/<file hash>" → change in that type's references. */
  readonly typed: Record<SetName, Map<string, number>> = { public: new Map(), private: new Map() }
  /** Per set: "<type>/<record hash>" of out-of-line records, until resolve(). */
  readonly #pointers: Record<SetName, Map<string, number>> = {
    public: new Map(),
    private: new Map(),
  }

  /** Change a type's references to a file by `n` (and the set's with it). */
  add(set: SetName, type: string, hash: string, n: number): void {
    if (n === 0) return
    this.refs[set].set(hash, (this.refs[set].get(hash) ?? 0) + n)
    const k = typedKey(type, hash)
    this.typed[set].set(k, (this.typed[set].get(k) ?? 0) + n)
  }

  #refsOf(set: SetName, type: string, body: string, by: number) {
    // Cheap prefilter: most records reference no files.
    if (!body.includes('"$file"')) return
    for (const h of fileRefs((JSON.parse(body) as { data: unknown }).data))
      this.add(set, type, h, by)
  }

  #body(set: SetName, type: string, body: string | undefined, by: number) {
    if (body === undefined) throw new Error('File reference accounting needs record bodies')
    const pointer = outOfLineHash(body)
    if (pointer) {
      const k = typedKey(type, pointer)
      this.#pointers[set].set(k, (this.#pointers[set].get(k) ?? 0) + by)
    } else this.#refsOf(set, type, body, by)
  }

  /** Feed one record change of a type in a set (mergeTree's onChange). */
  record(set: SetName, before: RecordEntry | null, after: RecordEntry | null, type: string): void {
    if (before) this.#body(set, type, before.body, -1)
    if (after) this.#body(set, type, after.body, +1)
  }

  /** Count the file references of out-of-line records seen as pointers. */
  async resolve(repo: Repo): Promise<void> {
    for (const set of ['public', 'private'] as const) {
      for (const [k, n] of this.#pointers[set]) {
        if (n === 0) continue
        const slash = k.lastIndexOf('/')
        this.#refsOf(set, k.slice(0, slash), await repo.outOfLineRecord(k.slice(slash + 1)), n)
      }
      this.#pointers[set].clear()
    }
  }

  get touched(): boolean {
    const all = [this.refs, this.#pointers].flatMap((r) => [
      ...r.public.values(),
      ...r.private.values(),
    ])
    return all.some((n) => n !== 0)
  }
}

/** Whether a count tree carries per-type counts (a null tree trivially does). */
export async function tracksTypes(repo: Repo, refsRoot: string | null): Promise<boolean> {
  if (refsRoot === null) return true
  return !!(await getEntry(new RepoSource(countTree, repo), refsRoot, MARKER))
}

/** One type's references per file, from a count tree that tracks types. O(those files). */
export async function typeFileRefs(
  repo: Repo,
  refsRoot: string | null,
  type: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const prefix = TYPED + typedKey(type, '')
  for await (const e of iterate(new RepoSource(countTree, repo), refsRoot, { after: prefix })) {
    if (!e.key.startsWith(prefix)) break
    out.set(e.key.slice(prefix.length), e.n)
  }
  return out
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

/** Sizes of files by hash; a hash it leaves out is a file the store doesn't have. */
export type FileSizes = (hashes: string[]) => Promise<Map<string, number>>

/** The declared-file markers currently in a count tree. O(declared files). */
export async function declaredFiles(repo: Repo, refsRoot: string | null): Promise<Set<string>> {
  const out = new Set<string>()
  for await (const e of iterate(new RepoSource(countTree, repo), refsRoot, { after: DECLARED })) {
    if (!e.key.startsWith(DECLARED)) break
    out.add(e.key.slice(DECLARED.length))
  }
  return out
}

/** How many of a set's records reference each file, from its count tree. O(files). */
export async function referenceCounts(
  repo: Repo,
  refsRoot: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for await (const e of iterate(new RepoSource(countTree, repo), refsRoot, { after: REF })) {
    if (!e.key.startsWith(REF)) break
    out.set(e.key.slice(REF.length), e.n)
  }
  return out
}

/**
 * Apply a set's reference deltas (and, for the private set, declared-file
 * changes) to its count tree and file tree.
 */
export async function applyFileSet(
  repo: Repo,
  base: { refsRoot: string | null; files: TreeSummary },
  refDeltas: Map<string, number>,
  declared: { add: string[]; remove: string[] } | null,
  fileSizes: FileSizes,
  /** Per-type deltas ("<type>/<hash>"), kept when the base tree tracks types. */
  typedDeltas?: Map<string, number>,
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

  // Per-type counts, only on a tree that has them all (see the header).
  const countChanges: Change<CountEntry>[] = []
  if (typedDeltas && (await tracksTypes(repo, base.refsRoot))) {
    for (const [k, d] of typedDeltas) {
      if (d === 0) continue
      const key = TYPED + k
      const old = (await getEntry(counts, base.refsRoot, key))?.n ?? 0
      const n = old + d
      if (n < 0) throw new Error(`Per-type file reference count for ${k} went negative`)
      countChanges.push({ key, entry: n > 0 ? { key, n } : null })
    }
    if (base.refsRoot === null) countChanges.push({ key: MARKER, entry: { key: MARKER, n: 1 } })
  }

  // New counts, and whether each touched file is present before and after.
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
  const sizes = await fileSizes(entering)
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
  // A tree left holding only its marker is no tree: nothing references a file.
  const marked = refs.root?.count === 1 && (await getEntry(counts, refs.root.hash, MARKER))
  return {
    refsRoot: marked ? null : (refs.root?.hash ?? null),
    files: files.root
      ? { root: files.root.hash, count: files.root.count, bytes: files.root.bytes }
      : { root: null, count: 0, bytes: 0 },
    added: entering,
  }
}

/**
 * The file reference count trees of a version, rebuilt from its records (they
 * are writer bookkeeping and travel with no sync, mirror or restore). Every
 * reference counts, and a private-set file no record references was declared.
 * Throws if the rebuilt file sets differ from the version's.
 */
export async function rebuildFileRefs(
  repo: Repo,
  sets: { public: SetObject; private: SetObject },
): Promise<{ public: string | null; private: string | null }> {
  const out = { public: null as string | null, private: null as string | null }
  for (const name of ['public', 'private'] as const) {
    const set = sets[name]
    const delta = new FileRefDelta()
    for (const [slug, t] of Object.entries(set.types)) {
      for await (const e of iterate(new RepoSource(recordTree, repo), t.root, { payloads: true })) {
        delta.record(name, null, e, slug)
      }
    }
    await delta.resolve(repo)
    const counts = delta.refs[name]
    const sizes = new Map<string, number>()
    for await (const e of iterate(new RepoSource(fileTree, repo), set.files.root)) {
      sizes.set(e.key, e.size)
    }
    const declared = name === 'private' ? [...sizes.keys()].filter((h) => !counts.has(h)) : []
    const result = await applyFileSet(
      repo,
      { refsRoot: null, files: { root: null, count: 0, bytes: 0 } },
      counts,
      declared.length > 0 ? { add: declared, remove: [] } : null,
      async (hs) => new Map(hs.filter((h) => sizes.has(h)).map((h) => [h, sizes.get(h)!])),
      delta.typed[name],
    )
    if (result.files.root !== set.files.root) {
      throw new Error(`The ${name} file set doesn't match its records' references`)
    }
    out[name] = result.refsRoot
  }
  return out
}
