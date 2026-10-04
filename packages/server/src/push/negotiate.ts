/**
 * Negotiate: the v1 push API, reimplemented on v2 storage so PubPub and the
 * current CLI keep working (edge-redesign.md, Push APIs 1).
 *
 * The manifest is a full snapshot of (type, id, hash, private). A manifest
 * entry is "present" only when the collection's base version has the same hash
 * for that (type, id), in either set. Presence never comes from a global
 * lookup, which closes the hash oracle structurally: a record or file the base
 * doesn't have must be uploaded.
 *
 * Commit diffs the base trees against the manifest in one sorted pass per type:
 * O(collection size), inherent to snapshots. Large pushers should use delta push.
 *
 * Format 1 hashes: a v1 client hashes data with integer-like keys differently
 * (edge-redesign-build.md finding 6). Uploads compute both hashes, so a manifest
 * entry matches an upload by either.
 */
import {
  type Change,
  compareUtf8,
  compileSchema,
  declaredFiles,
  getEntry,
  hasArrayIndexKey,
  iterate,
  legacyRecordHash,
  type RecordEntry,
  recordTree,
  type Repo,
  RepoSource,
} from '@underlay/protocol'

import type { Ports } from '../ports.js'
import { type CommitResult, commitVersion, type TypeInput } from '../versions/commit.js'
import { isPrivateSchema, takeStaged, toRecordEntry } from './changes.js'
import { headBase } from './delta.js'
import { mergeRuns, type RunEntry, type RunIndex } from './runs.js'
import {
  loadInputs,
  schemaHashes,
  type SessionInputs,
  sessionRuns,
  type SessionRow,
} from './session.js'

const HEX64 = /^[0-9a-f]{64}$/

export interface ManifestLine {
  id: string
  type: string
  hash: string
  private?: boolean
}

export function parseManifestLine(v: unknown): ManifestLine | string {
  const m = v as Partial<ManifestLine>
  if (!m || typeof m !== 'object') return 'not an object'
  if (typeof m.id !== 'string' || m.id.length === 0) return 'id must be a non-empty string'
  if (typeof m.type !== 'string') return 'type must be a string'
  if (typeof m.hash !== 'string' || !HEX64.test(m.hash))
    return 'hash must be a lowercase hex sha256'
  if (m.private !== undefined && typeof m.private !== 'boolean') return 'private must be a boolean'
  return m as ManifestLine
}

export interface BaseTrees {
  repo: Repo
  pub: Record<string, { root: string | null }>
  priv: Record<string, { root: string | null }>
}

export async function baseTrees(
  ports: Ports,
  collectionId: string,
  baseHash: string | null,
): Promise<BaseTrees> {
  const repo = await ports.stores.forCollection(collectionId)
  if (!baseHash) return { repo, pub: {}, priv: {} }
  const root = await repo.root(baseHash)
  const priv = root.private ? await repo.privateSet(root.private) : null
  return { repo, pub: root.public.types, priv: priv?.types ?? {} }
}

/**
 * Which manifest entries the server needs uploaded: those the base doesn't hold
 * with the same hash. Entries are looked up in (type, id) order so consecutive
 * keys share cached leaves.
 */
export async function neededOf(trees: BaseTrees, entries: ManifestLine[]): Promise<string[]> {
  const source = new RepoSource(recordTree, trees.repo)
  const sorted = entries
    .slice()
    .sort((a, b) => compareUtf8(a.type, b.type) || compareUtf8(a.id, b.id))
  const needed: string[] = []
  for (const m of sorted) {
    let present = false
    for (const set of [trees.pub, trees.priv]) {
      const root = set[m.type]?.root ?? null
      if (!root) continue
      if ((await getEntry(source, root, m.id))?.hash === m.hash) present = true
    }
    if (!present) needed.push(m.hash)
  }
  return needed
}

/** Run entries for uploaded records: like delta uploads, plus the format 1 hash when it differs. */
export function withLegacyHash(e: RunEntry, data: unknown): RunEntry {
  if (!hasArrayIndexKey(data)) return e
  const lh = legacyRecordHash(e.k, e.t, data)
  return lh === e.h ? e : { ...e, lh }
}

type Tagged = { key: string; set: 'public' | 'private'; hash: string }

async function* baseEntries(
  source: RepoSource<RecordEntry>,
  pubRoot: string | null,
  privRoot: string | null,
): AsyncGenerator<Tagged> {
  const pub = iterate(source, pubRoot)[Symbol.asyncIterator]()
  const priv = iterate(source, privRoot)[Symbol.asyncIterator]()
  let a = await pub.next()
  let b = await priv.next()
  while (!a.done || !b.done) {
    if (b.done || (!a.done && compareUtf8(a.value.key, b.value.key) <= 0)) {
      yield { key: a.value!.key, set: 'public', hash: a.value!.hash }
      a = await pub.next()
    } else {
      yield { key: b.value.key, set: 'private', hash: b.value.hash }
      b = await priv.next()
    }
  }
}

/** One step of the snapshot diff for a key. */
interface Step {
  key: string
  manifest: RunEntry | null
  base: Tagged | null
  upload: RunEntry | null
}

/** Zip the manifest, the base and the uploads of one type by id. */
async function* zip(
  manifest: AsyncIterable<RunEntry>,
  base: AsyncIterable<Tagged>,
  uploads: AsyncIterable<RunEntry>,
): AsyncGenerator<Step> {
  const mi = manifest[Symbol.asyncIterator]()
  const bi = base[Symbol.asyncIterator]()
  const ui = uploads[Symbol.asyncIterator]()
  let m = await mi.next()
  let b = await bi.next()
  let u = await ui.next()
  for (;;) {
    const keys = [
      m.done ? null : m.value.k,
      b.done ? null : b.value.key,
      u.done ? null : u.value.k,
    ].filter((k): k is string => k !== null)
    if (keys.length === 0) return
    const key = keys.reduce((x, y) => (compareUtf8(x, y) <= 0 ? x : y))
    const step: Step = { key, manifest: null, base: null, upload: null }
    if (!m.done && m.value.k === key) {
      step.manifest = m.value
      m = await mi.next()
    }
    if (!b.done && b.value.key === key) {
      step.base = b.value
      b = await bi.next()
    }
    if (!u.done && u.value.k === key) {
      step.upload = u.value
      u = await ui.next()
    }
    yield step
  }
}

/** A base record's body, for a record that moves between sets unchanged. */
async function baseBody(
  source: RepoSource<RecordEntry>,
  root: string,
  key: string,
): Promise<RecordEntry> {
  let hash = root
  for (;;) {
    const node = await source.node(hash)
    if (node.kind === 'leaf') {
      const e = (await source.leafEntries(hash)).find((x) => x.key === key)
      if (!e) throw new Error(`Base record ${key} vanished`)
      return e
    }
    const child = node.children.find((c) => compareUtf8(key, c.lastKey) <= 0)
    if (!child) throw new Error(`Base record ${key} vanished`)
    hash = child.hash
  }
}

interface SnapshotPlan {
  types: TypeInput[]
  /** The first 100 missing hashes, and how many there are. */
  missing: string[]
  missingCount: number
  manifestCount: number
}

/** Build per-type change streams from the snapshot diff, and count what's missing. */
async function planSnapshot(
  ports: Ports,
  session: SessionRow,
  inputs: SessionInputs,
  trees: BaseTrees,
  manifestRuns: RunIndex[],
  recordRuns: RunIndex[],
): Promise<SnapshotPlan> {
  const internal = ports.stores.internal
  const source = new RepoSource(recordTree, trees.repo)
  const hashes = schemaHashes(inputs.schemas)
  const missing: string[] = []
  let manifestCount = 0
  let missingCount = 0

  const stepsFor = (slug: string) =>
    zip(
      mergeRuns(internal, session.id, manifestRuns, { type: slug }),
      baseEntries(source, trees.pub[slug]?.root ?? null, trees.priv[slug]?.root ?? null),
      mergeRuns(internal, session.id, recordRuns, { type: slug }),
    )

  const uploadFor = (st: Step) =>
    st.manifest && st.upload && (st.upload.h === st.manifest.h || st.upload.lh === st.manifest.h)
      ? st.upload
      : null

  // Pre-pass: everything in the manifest must be in the base or uploaded.
  for (const slug of Object.keys(inputs.schemas)) {
    for await (const st of stepsFor(slug)) {
      if (!st.manifest) continue
      manifestCount++
      if (!uploadFor(st) && st.base?.hash !== st.manifest.h) {
        missingCount++
        if (missing.length < 100) missing.push(st.manifest.h!)
      }
    }
  }

  const types: TypeInput[] = Object.entries(inputs.schemas).map(([slug, s]) => {
    const privateType = isPrivateSchema(s)
    const stream = async function* (
      set: 'public' | 'private',
    ): AsyncGenerator<Change<RecordEntry>> {
      for await (const st of stepsFor(slug)) {
        const inBase = st.base?.set === set
        if (!st.manifest) {
          if (inBase) yield { key: st.key, entry: null } // dropped from the snapshot
          continue
        }
        const target = privateType || st.manifest.p ? 'private' : 'public'
        if (target !== set) {
          if (inBase) yield { key: st.key, entry: null } // left this set
          continue
        }
        const upload = uploadFor(st)
        const wanted = upload ? upload.h! : st.manifest.h!
        if (inBase && st.base!.hash === wanted) continue // unchanged
        if (upload) {
          await takeStaged(internal, trees.repo, session.id, upload.b)
          yield { key: st.key, entry: toRecordEntry(upload) }
        } else {
          // Not uploaded, so the base has it (the pre-pass checked) in the other
          // set: the same record moving here.
          const otherRoot = (st.base!.set === 'public' ? trees.pub : trees.priv)[slug]!.root!
          yield { key: st.key, entry: await baseBody(source, otherRoot, st.key) }
        }
      }
    }
    return {
      slug,
      schema: s,
      schemaHash: hashes[slug]!,
      public: privateType ? null : stream('public'),
      private: stream('private'),
    }
  })
  return { types, missing, missingCount, manifestCount }
}

export async function commitNegotiateSession(
  ports: Ports,
  session: SessionRow,
  fence: number,
): Promise<
  | CommitResult
  | { status: 'base_moved'; current: string | null }
  | { status: 'manifest_error'; body: Record<string, unknown> }
> {
  const base = await headBase(ports, session.collectionId)
  // v1 semantics: a null base_version means "commit on whatever the head is".
  if (session.baseSemver !== null && (base?.id ?? null) !== session.baseVersionId) {
    return { status: 'base_moved', current: base?.semver ?? null }
  }
  const inputs = await loadInputs(ports, session.id)
  const manifestRuns = await sessionRuns(ports, session.id, 'manifest')
  const recordRuns = await sessionRuns(ports, session.id, 'records')
  const trees = await baseTrees(ports, session.collectionId, base?.hash ?? null)

  const plan = await planSnapshot(ports, session, inputs, trees, manifestRuns, recordRuns)
  if (session.manifestExpected !== null && plan.manifestCount !== session.manifestExpected) {
    return {
      status: 'manifest_error',
      body: {
        error: 'Manifest incomplete',
        message: `Expected ${session.manifestExpected} manifest entries but received ${plan.manifestCount}.`,
        manifest_expected: session.manifestExpected,
        manifest_received: plan.manifestCount,
        statusCode: 400,
      },
    }
  }
  if (plan.missing.length > 0) {
    return {
      status: 'manifest_error',
      body: {
        error: 'Missing records',
        missing_hashes: plan.missing,
        message: `${plan.missingCount} needed record(s) have not been submitted.`,
        statusCode: 400,
      },
    }
  }

  // v1 merges the pushed metadata over the previous version's.
  const prevMetadata = base ? (await trees.repo.root(base.hash)).metadata : null
  const metadata = inputs.metadata ? { ...(prevMetadata ?? {}), ...inputs.metadata } : prevMetadata

  // Declared files are a full list in v1; turn it into adds and removes.
  const all = 'all' in inputs.files ? inputs.files.all : []
  const before = await declaredFiles(trees.repo, base?.privateRefsRoot ?? null)
  const now = new Set(all)
  const declared = {
    add: all.filter((h) => !before.has(h)),
    remove: [...before].filter((h) => !now.has(h)),
  }

  return commitVersion(ports, {
    collectionId: session.collectionId,
    fence,
    base,
    types: plan.types,
    metadata,
    declaredFiles: declared,
    message: session.message,
    pushedBy: session.userId,
    appId: session.appId,
    actorId: session.actorId,
    validate: (s, data) => {
      const errs = compileSchema(s)(data)
      return errs.length > 0 ? errs : null
    },
  })
}
