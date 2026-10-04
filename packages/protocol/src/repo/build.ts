/**
 * Building a version: a base version plus sorted changes per (set, type) become
 * new trees, file sets and a root, written to the repository. This is the commit
 * engine without the platform: the server publishes the result with
 * compare-and-swap (packages/server/src/versions/commit.ts), and the CLI builds
 * local versions with it, so both make the same trees from the same changes.
 *
 *   1. per (set, type): merge the base tree with that set's changes (unchanged
 *      trees are reused; a type that changes privacy moves its tree);
 *   2. removed types release their file references;
 *   3. types whose schema changed are revalidated (O(type size));
 *   4. file sets from reference-count deltas (file-sets.ts);
 *   5. the private set object and the root.
 *
 * Every object is keyed by content, so a failed or abandoned build leaves only
 * unreferenced objects.
 */
import {
  type Change,
  compareUtf8,
  emptySet,
  isEmptySet,
  iterate,
  makeRoot,
  mergeTree,
  type PrivateSetObject,
  type RecordEntry,
  recordTree,
  type SetObject,
  type TreeSummary,
  type VersionRoot,
} from '../format.js'
import { applyFileSet, FileRefDelta, type FileSizes, type SetName } from './file-sets.js'
import {
  bodyOfRecord,
  dropRecordBody,
  recordPayloadBytes,
  type Repo,
  RepoSink,
  RepoSource,
} from './repo.js'

export type ChangeSource = Iterable<Change<RecordEntry>> | AsyncIterable<Change<RecordEntry>>

export interface BuildTypeInput {
  slug: string
  schema: Record<string, unknown>
  schemaHash: string
  /** Sorted changes per set (null: no changes there). Upserts carry `body`. */
  public: ChangeSource | null
  private: ChangeSource | null
}

export interface BuildInput {
  /** The base version, with its sets' file reference count trees (writer bookkeeping). */
  base: { hash: string; publicRefsRoot: string | null; privateRefsRoot: string | null } | null
  /** The full new type set: types in the base but not here are removed. */
  types: BuildTypeInput[]
  /** The full new metadata. */
  metadata: Record<string, unknown> | null
  /** Changes to declared (possibly unreferenced) files. */
  declaredFiles?: { add: string[]; remove: string[] }
  /** The collection's private-set salt. */
  salt: string
  /** Sizes of files entering a set; a missing one fails the build (MissingFilesError). */
  fileSizes: FileSizes
  /** Validate a record's data against its type's schema; errors or null. Used when a schema changes. */
  validate?: (schema: Record<string, unknown>, data: unknown) => string[] | null
  /**
   * Trees already merged elsewhere (a parallel commit), per type, with the file
   * reference deltas and change counts that built them. The types' change
   * sources are then ignored. Only when no type changes privacy or schema and
   * none is removed.
   */
  prebuilt?: {
    trees: Record<string, { public: TreeSummary; private: TreeSummary }>
    refs: FileRefDelta
    stats: { added: number; removed: number; updated: number }
  }
}

export type BuildResult =
  | {
      status: 'built'
      versionHash: string
      root: VersionRoot
      privateSet: PrivateSetObject | null
      basePublic: SetObject
      basePrivate: SetObject
      newPublic: SetObject
      newPrivate: SetObject
      publicRefsRoot: string | null
      privateRefsRoot: string | null
      /** Files that entered the public set. */
      publicFilesAdded: string[]
      stats: { added: number; removed: number; updated: number }
      schemaChanged: boolean
      recordsChanged: boolean
      /** Every key written, in order. */
      written: string[]
    }
  | {
      status: 'invalid'
      errors: { recordId: string; type: string; errors: string[] }[]
      total: number
    }

const MAX_REPORTED_ERRORS = 100
const SPILL_BYTES = 4 * 1024 * 1024

const summaryOf = (t: {
  root: { hash: string; count: number; bytes: number } | null
}): TreeSummary =>
  t.root
    ? { root: t.root.hash, count: t.root.count, bytes: t.root.bytes }
    : { root: null, count: 0, bytes: 0 }

export const isPrivateSchema = (s: Record<string, unknown>) => s.private === true

async function* asAsync<T>(src: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  yield* src as AsyncIterable<T>
}

/** Merge two sorted change streams; on equal keys the second wins. */
async function* overlay(
  a: AsyncIterable<Change<RecordEntry>>,
  b: AsyncIterable<Change<RecordEntry>>,
): AsyncGenerator<Change<RecordEntry>> {
  const ai = a[Symbol.asyncIterator]()
  const bi = b[Symbol.asyncIterator]()
  let x = await ai.next()
  let y = await bi.next()
  while (!x.done || !y.done) {
    if (y.done || (!x.done && compareUtf8(x.value.key, y.value.key) < 0)) {
      yield x.value
      x = await ai.next()
    } else if (x.done || compareUtf8(y.value.key, x.value.key) < 0) {
      yield y.value
      y = await bi.next()
    } else {
      yield y.value
      x = await ai.next()
      y = await bi.next()
    }
  }
}

/** Every entry of a tree (with bodies) as upserts. */
async function* treeAsUpserts(
  repo: Repo,
  root: string | null,
): AsyncGenerator<Change<RecordEntry>> {
  for await (const e of iterate(new RepoSource(recordTree, repo), root, { payloads: true })) {
    yield { key: e.key, entry: e }
  }
}

const summary = (t: TreeSummary | undefined): TreeSummary =>
  t ? { root: t.root, count: t.count, bytes: t.bytes } : { root: null, count: 0, bytes: 0 }

export async function buildVersion(repo: Repo, input: BuildInput): Promise<BuildResult> {
  const base = input.base
  const baseRoot = base ? await repo.root(base.hash) : null
  const basePublic: SetObject = baseRoot?.public ?? emptySet()
  const basePrivate: SetObject = baseRoot?.private
    ? await repo.privateSet(baseRoot.private)
    : emptySet()

  const source = new RepoSource(recordTree, repo)
  const sink = new RepoSink<RecordEntry>(repo, { bodyOf: bodyOfRecord })
  const builderOpts = {
    payloadBytes: recordPayloadBytes,
    dropPayload: dropRecordBody,
    spillBytes: SPILL_BYTES,
  }
  const refs = input.prebuilt?.refs ?? new FileRefDelta()
  const stats = input.prebuilt ? { ...input.prebuilt.stats } : { added: 0, removed: 0, updated: 0 }
  let recordsChanged = stats.added + stats.removed + stats.updated > 0

  const newPublic: SetObject = emptySet()
  const newPrivate: SetObject = emptySet()

  // Stats count per set: a record moving between sets is a removal and an addition.
  const merge = async (
    set: SetName,
    baseTree: string | null,
    changes: AsyncIterable<Change<RecordEntry>>,
  ) => {
    const result = await mergeTree(source, sink, baseTree, changes, {
      ...builderOpts,
      onChange: (before, after) => {
        refs.record(set, before, after)
        recordsChanged = true
        if (before && after) stats.updated++
        else if (after) stats.added++
        else stats.removed++
      },
    })
    return summaryOf(result)
  }

  const inputSlugs = new Set(input.types.map((t) => t.slug))
  let schemaChanged = false

  // Schemas are repository objects too (schemas/<hash>.json).
  await Promise.all(
    input.types.map(async (t) => {
      if ((await repo.putSchema(t.schema)) !== t.schemaHash) {
        throw new Error(`Schema for ${t.slug} does not match its hash`)
      }
    }),
  )
  sink.written.push(...input.types.map((t) => `schemas/${t.schemaHash}.json`))

  for (const t of input.types) {
    const pubBase = basePublic.types[t.slug]
    const privBase = basePrivate.types[t.slug]
    if ((pubBase ?? privBase)?.schema !== t.schemaHash) schemaChanged = true
    const prebuilt = input.prebuilt?.trees[t.slug]
    if (input.prebuilt) {
      if (!prebuilt) throw new Error(`Parallel commit has no trees for type ${t.slug}`)
      if (isPrivateSchema(t.schema)) {
        newPrivate.types[t.slug] = { schema: t.schemaHash, ...prebuilt.private }
      } else {
        newPublic.types[t.slug] = { schema: t.schemaHash, ...prebuilt.public }
        if (prebuilt.private.root)
          newPrivate.types[t.slug] = { schema: t.schemaHash, ...prebuilt.private }
      }
      continue
    }
    const nowPrivate = isPrivateSchema(t.schema)
    const wasPrivateType = !pubBase && !!privBase
    const pubChanges = t.public ? asAsync(t.public) : null
    const privChanges = t.private ? asAsync(t.private) : null

    let pub: TreeSummary = { root: null, count: 0, bytes: 0 }
    let priv: TreeSummary = { root: null, count: 0, bytes: 0 }
    const pubRoot = pubBase?.root ?? null
    const privRoot = privBase?.root ?? null

    if (nowPrivate) {
      // Every record of a private type is in the private set. If the type was
      // public, its public records move over: a plain move when the private
      // tree was empty, otherwise a merge.
      if (pubChanges)
        throw new Error(`Type ${t.slug} is private; its changes belong to the private set`)
      if (pubRoot && !privRoot && !privChanges) {
        priv = pubBase!
      } else if (pubRoot) {
        priv = await merge(
          'private',
          privRoot,
          overlay(treeAsUpserts(repo, pubRoot), privChanges ?? asAsync([])),
        )
        for await (const e of treeAsUpserts(repo, pubRoot)) refs.record('public', e.entry, null)
      } else {
        priv = privChanges ? await merge('private', privRoot, privChanges) : summary(privBase)
      }
      if (pubRoot) recordsChanged = true
    } else if (wasPrivateType) {
      // A private type made public: its records become public (per-record flags
      // were not kept while the whole type was private), except those this push
      // marks private.
      pub = await merge(
        'public',
        null,
        overlay(treeAsUpserts(repo, privRoot), pubChanges ?? asAsync([])),
      )
      for await (const e of treeAsUpserts(repo, privRoot)) refs.record('private', e.entry, null)
      priv = privChanges
        ? await merge('private', null, privChanges)
        : { root: null, count: 0, bytes: 0 }
      recordsChanged = true
    } else {
      pub = pubChanges ? await merge('public', pubRoot, pubChanges) : summary(pubBase)
      priv = privChanges ? await merge('private', privRoot, privChanges) : summary(privBase)
    }

    if (nowPrivate) {
      newPrivate.types[t.slug] = { schema: t.schemaHash, ...priv }
    } else {
      newPublic.types[t.slug] = { schema: t.schemaHash, ...pub }
      if (priv.root) newPrivate.types[t.slug] = { schema: t.schemaHash, ...priv }
    }
  }

  // Removed types: drop their trees, and release their file references.
  for (const [set, base_] of [
    ['public', basePublic],
    ['private', basePrivate],
  ] as const) {
    for (const [slug, entry] of Object.entries(base_.types)) {
      if (inputSlugs.has(slug)) continue
      schemaChanged = true
      for await (const e of treeAsUpserts(repo, entry.root)) {
        refs.record(set, e.entry, null)
        stats.removed++
        recordsChanged = true
      }
    }
  }
  await sink.flush()

  // Revalidate types whose schema changed (records pushed earlier were checked
  // against the old schema). O(type size), inherent to a schema change.
  const errors: { recordId: string; type: string; errors: string[] }[] = []
  let errorCount = 0
  if (input.validate) {
    for (const t of input.types) {
      const before = basePublic.types[t.slug] ?? basePrivate.types[t.slug]
      if (!before || before.schema === t.schemaHash) continue
      for (const tree of [newPublic.types[t.slug], newPrivate.types[t.slug]]) {
        for await (const e of iterate(source, tree?.root ?? null, { payloads: true })) {
          const errs = input.validate(t.schema, (JSON.parse(e.body!) as { data: unknown }).data)
          if (errs) {
            errorCount++
            if (errors.length < MAX_REPORTED_ERRORS)
              errors.push({ recordId: e.key, type: t.slug, errors: errs })
          }
        }
      }
    }
  }
  if (errorCount > 0) return { status: 'invalid', errors, total: errorCount }

  // File sets.
  const pubFiles = await applyFileSet(
    repo,
    { refsRoot: base?.publicRefsRoot ?? null, files: basePublic.files },
    refs.refs.public,
    null,
    input.fileSizes,
  )
  const privFiles = await applyFileSet(
    repo,
    { refsRoot: base?.privateRefsRoot ?? null, files: basePrivate.files },
    refs.refs.private,
    input.declaredFiles ?? null,
    input.fileSizes,
  )
  newPublic.files = pubFiles.files
  newPrivate.files = privFiles.files

  // Root.
  const privSet: PrivateSetObject = { ...newPrivate, salt: input.salt }
  const root = makeRoot(input.metadata, newPublic, isEmptySet(newPrivate) ? null : privSet)
  if (root.private) await repo.putPrivateSet(privSet)
  const versionHash = await repo.putRoot(root)
  return {
    status: 'built',
    versionHash,
    root,
    privateSet: root.private ? privSet : null,
    basePublic,
    basePrivate,
    newPublic,
    newPrivate,
    publicRefsRoot: pubFiles.refsRoot,
    privateRefsRoot: privFiles.refsRoot,
    publicFilesAdded: pubFiles.added,
    stats,
    schemaChanged,
    recordsChanged,
    written: sink.written,
  }
}
