import { hashSchema } from '../hash.js'
/**
 * fsck for a repository: everything a reader trusts, checked from storage.
 *
 *   - the collection's signed log, when a collection is named: entries chain,
 *     verify under the given keys (else the keys collection.json declares, which
 *     proves integrity but not origin), and end at head.json;
 *   - each version's root and set objects (shape), and its schemas (hash);
 *   - each record and file tree, structurally (verifyTree: every node, every
 *     chunking rule), and its count and bytes against the set's summary;
 *   - every leaf body: each line is its entry's record (Repo.bodyLines);
 *   - every file the file trees list: present at its size, and with
 *     `fileBytes`, hashed.
 *
 * Trees and leaves shared between versions are checked once. Problems are
 * collected, not thrown, so one bad object doesn't hide the rest. It reads the
 * repository's store directly: no cache answers for it, and every object is
 * hash-checked.
 */
import { checkSetObject, type SetObject } from '../root.js'
import { sha256Hasher } from '../sha256.js'
import { mergeTree } from '../tree/merge.js'
import { fileTree, recordTree, type RecordEntry } from '../tree/node.js'
import { diffTrees, leaves, newNodes } from '../tree/read.js'
import { verifyTree } from '../tree/verify.js'
import {
  type PublicKeyInfo,
  readCollectionInfo,
  readHead,
  readLogEntry,
  verifyLog,
  verifyLogEntries,
} from './log.js'
import { keys, openRepo, type Repo, RepoSource } from './repo.js'

export interface FsckOptions {
  /** Version hashes to check; with a collection id and none given, the log's. */
  versions?: string[]
  /** Check this collection's log (collections/<id>/). */
  collectionId?: string
  /** Keys the log must be signed by; default: those its collection.json declares. */
  trustedKeys?: PublicKeyInfo[]
  /** Read and hash every file's bytes, not just check it's there at its size. */
  fileBytes?: boolean
  maxErrors?: number
}

export interface FsckReport {
  ok: boolean
  errors: string[]
  /** Problems past maxErrors, not listed. */
  moreErrors: number
  versions: number
  trees: number
  nodes: number
  leaves: number
  records: number
  files: number
  /** How the log was checked: given keys, collection.json's own, or not at all. */
  log: 'trusted keys' | 'declared keys' | 'not checked'
}

export async function fsck(given: Repo, opts: FsckOptions = {}): Promise<FsckReport> {
  // Storage itself: no shared cache or memory of earlier reads, and every object
  // hash-checked as if from a location we don't operate.
  const repo = openRepo(given.blobs, { trusted: false })
  const max = opts.maxErrors ?? 100
  const report: FsckReport = {
    ok: true,
    errors: [],
    moreErrors: 0,
    versions: 0,
    trees: 0,
    nodes: 0,
    leaves: 0,
    records: 0,
    files: 0,
    log: 'not checked',
  }
  const fail = (msg: string) => {
    report.ok = false
    if (report.errors.length < max) report.errors.push(msg)
    else report.moreErrors++
  }
  const attempt = async <T>(what: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f()
    } catch (err) {
      fail(`${what}: ${(err as Error).message}`)
      return null
    }
  }

  // The log.
  let versions = opts.versions ?? []
  if (opts.collectionId) {
    const id = opts.collectionId
    const info = await attempt('collection.json', () => readCollectionInfo(repo, id))
    if (!info) {
      if (!report.errors.length) fail('collection.json is missing')
    } else {
      const keys_ = opts.trustedKeys ?? info.keys
      report.log = opts.trustedKeys ? 'trusted keys' : 'declared keys'
      await attempt('log', () => verifyLog(repo, id, keys_))
      if (!opts.versions) {
        const head = await readHead(repo, id)
        const hashes: string[] = []
        for (let seq = 1; seq <= (head?.seq ?? 0); seq++) {
          const e = await readLogEntry(repo, id, seq)
          if (e) hashes.push(e.versionHash)
        }
        versions = hashes
      }
    }
  }

  const records = new RepoSource(recordTree, repo)
  const files = new RepoSource(fileTree, repo)
  const seenTrees = new Set<string>()
  const seenLeaves = new Set<string>()
  const seenFiles = new Set<string>()
  const seenSchemas = new Set<string>()

  const checkSet = async (where: string, set: SetObject) => {
    for (const [slug, t] of Object.entries(set.types)) {
      if (!seenSchemas.has(t.schema)) {
        seenSchemas.add(t.schema)
        const body = await attempt(`${where} type ${slug} schema`, () => repo.schema(t.schema))
        if (body && hashSchema(body) !== t.schema) fail(`schema ${t.schema} fails its hash`)
      }
      if (!t.root || seenTrees.has(t.root)) continue
      seenTrees.add(t.root)
      report.trees++
      const v = await verifyTree(records, t.root)
      report.nodes += v.nodes
      for (const e of v.errors) fail(`${where} type ${slug}: ${e}`)
      if (v.ok && (v.count !== t.count || v.bytes !== t.bytes))
        fail(
          `${where} type ${slug}: tree has ${v.count} records / ${v.bytes} bytes, summary says ${t.count} / ${t.bytes}`,
        )
      report.records += v.count
      // Every body line is its entry's record.
      for await (const leaf of leaves(records, t.root)) {
        if (seenLeaves.has(leaf.hash)) continue
        seenLeaves.add(leaf.hash)
        report.leaves++
        const node = await attempt(`leaf ${leaf.hash}`, () => records.node(leaf.hash))
        if (!node || node.kind !== 'leaf') continue
        await attempt(`body of ${leaf.hash}`, () =>
          repo.bodyLines({ hash: leaf.hash, entries: node.entries as RecordEntry[] }),
        )
      }
    }
    const f = set.files
    if (f.root && !seenTrees.has(f.root)) {
      seenTrees.add(f.root)
      report.trees++
      const v = await verifyTree(files, f.root)
      report.nodes += v.nodes
      for (const e of v.errors) fail(`${where} files: ${e}`)
      if (v.ok && (v.count !== f.count || v.bytes !== f.bytes))
        fail(
          `${where} files: tree has ${v.count} / ${v.bytes}, summary says ${f.count} / ${f.bytes}`,
        )
      for await (const leaf of leaves(files, f.root)) {
        const node = await files.node(leaf.hash)
        if (node.kind !== 'leaf') continue
        for (const e of node.entries) {
          if (seenFiles.has(e.key)) continue
          seenFiles.add(e.key)
          report.files++
          await checkFile(e.key, e.size)
        }
      }
    }
  }

  const checkFile = async (hash: string, size: number) => {
    const key = keys.file(hash)
    if (!opts.fileBytes) {
      const head = await attempt(`file ${hash}`, () => repo.blobs.head(key))
      if (!head) fail(`file ${hash} is missing`)
      else if (head.size !== size) fail(`file ${hash} is ${head.size} bytes, listed as ${size}`)
      return
    }
    const obj = await attempt(`file ${hash}`, () => repo.blobs.get(key))
    if (!obj) return fail(`file ${hash} is missing`)
    const h = sha256Hasher()
    let n = 0
    const reader = obj.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      h.update(value)
      n += value.byteLength
    }
    if (n !== size || h.hex() !== hash) fail(`file ${hash} fails its hash or size`)
  }

  for (const hash of versions) {
    report.versions++
    const where = `version ${hash.slice(0, 17)}…`
    const root = await attempt(where, () => repo.root(hash))
    if (!root) continue
    const pubErr = checkSetObject(root.public)
    if (pubErr) fail(`${where} public ${pubErr}`)
    else await checkSet(`${where} public`, root.public)
    if (root.private) {
      // A public-only copy (a mirror of public sets) lacks the private set: not an error.
      if (!(await repo.blobs.head(keys.privateSet(root.private)))) continue
      const priv = await attempt(`${where} private set`, () => repo.privateSet(root.private!))
      if (!priv) continue
      const privErr = checkSetObject(priv, true)
      if (privErr) fail(`${where} private ${privErr}`)
      else await checkSet(`${where} private`, priv)
    }
  }
  return report
}

// --- Resumable fsck ---------------------------------------------------------------------

/** Where a resumable check stopped: the last version checked, and the log chain there. */
export interface FsckCursor {
  seq: number
  log: { seq: number; entryHash: string } | null
  /** The last version checked; the next is checked against it. */
  versionHash: string | null
}

export interface FsckStepOptions {
  collectionId: string
  /** Keys the log must be signed by. */
  trustedKeys: PublicKeyInfo[]
  fileBytes?: boolean
  /** Where the last step stopped (null: from the start). */
  cursor: FsckCursor | null
  /** Stop after the version that takes the changes checked past this (at least one version). */
  changeBudget?: number
  maxErrors?: number
}

/**
 * Check a collection's log and versions a few at a time, so a check of any size
 * fits in bounded jobs. Each version is checked against the one before, in
 * O(its changes): a tree is canonical when merging its diff from the previous
 * (already checked) tree into that tree rebuilds exactly its root, and only its
 * new leaves' bodies and new files are read. The first version is checked
 * against nothing, so it costs O(its size). With the last version, head.json
 * must match the last entry. Returns the step's report (the caller adds steps
 * up) and the next cursor, null when done.
 */
export async function fsckStep(
  given: Repo,
  opts: FsckStepOptions,
): Promise<{ report: FsckReport; cursor: FsckCursor | null }> {
  const repo = openRepo(given.blobs, { trusted: false })
  const max = opts.maxErrors ?? 100
  const budget = opts.changeBudget ?? 1_000_000
  const report: FsckReport = {
    ok: true,
    errors: [],
    moreErrors: 0,
    versions: 0,
    trees: 0,
    nodes: 0,
    leaves: 0,
    records: 0,
    files: 0,
    log: 'trusted keys',
  }
  const fail = (msg: string) => {
    report.ok = false
    if (report.errors.length < max) report.errors.push(msg)
    else report.moreErrors++
  }
  const attempt = async <T>(what: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f()
    } catch (err) {
      fail(`${what}: ${(err as Error).message}`)
      return null
    }
  }
  const id = opts.collectionId
  const head = await attempt('head.json', () => readHead(repo, id))
  if (!head) {
    if (report.ok) fail('head.json is missing')
    return { report, cursor: null }
  }
  const records = new RepoSource(recordTree, repo)
  const files = new RepoSource(fileTree, repo)
  let cursor: FsckCursor = opts.cursor ?? { seq: 0, log: null, versionHash: null }
  const noSink = { leaf() {}, interior() {} }

  /** Whether `root` is the canonical tree its diff from `base` makes; counts its changes. */
  const checkTree = async <E>(
    where: string,
    source: RepoSource<E>,
    base: string | null,
    root: string | null,
    onAdded?: (e: E) => Promise<void>,
  ): Promise<{ changes: number; count: number; bytes: number } | null> => {
    if (base === root) return null
    report.trees++
    let changes = 0
    const diff = async function* () {
      for await (const d of diffTrees(source, base, root)) {
        changes++
        if (d.after && onAdded) await onAdded(d.after)
        yield { key: d.key, entry: d.after }
      }
    }
    const merged = await attempt(where, () => mergeTree(source, noSink, base, diff()))
    if (!merged) return null
    if ((merged.root?.hash ?? null) !== root) {
      fail(`${where}: not canonical (its entries make ${merged.root?.hash ?? 'an empty tree'})`)
      return null
    }
    for await (const n of newNodes(source, base, root)) {
      report.nodes++
      if (n.level === 0) report.leaves++
    }
    return { changes, count: merged.root?.count ?? 0, bytes: merged.root?.bytes ?? 0 }
  }

  const checkFile = async (hash: string, size: number) => {
    report.files++
    const key = keys.file(hash)
    if (!opts.fileBytes) {
      const h = await attempt(`file ${hash}`, () => repo.blobs.head(key))
      if (!h) fail(`file ${hash} is missing`)
      else if (h.size !== size) fail(`file ${hash} is ${h.size} bytes, listed as ${size}`)
      return
    }
    const obj = await attempt(`file ${hash}`, () => repo.blobs.get(key))
    if (!obj) return fail(`file ${hash} is missing`)
    const hasher = sha256Hasher()
    let n = 0
    const reader = obj.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hasher.update(value)
      n += value.byteLength
    }
    if (n !== size || hasher.hex() !== hash) fail(`file ${hash} fails its hash or size`)
  }

  const checkSet = async (where: string, set: SetObject, base: SetObject | null) => {
    let changes = 0
    for (const [slug, t] of Object.entries(set.types)) {
      const was = base?.types[slug]
      if (was?.schema !== t.schema) {
        const body = await attempt(`${where} type ${slug} schema`, () => repo.schema(t.schema))
        if (body && hashSchema(body) !== t.schema) fail(`schema ${t.schema} fails its hash`)
      }
      const r = await checkTree(`${where} type ${slug}`, records, was?.root ?? null, t.root)
      if (!r) continue
      changes += r.changes
      report.records += r.changes
      if (r.count !== t.count || r.bytes !== t.bytes)
        fail(
          `${where} type ${slug}: tree has ${r.count} records / ${r.bytes} bytes, summary says ${t.count} / ${t.bytes}`,
        )
      // Every new leaf's body is its entries' records.
      for await (const n of newNodes(records, was?.root ?? null, t.root)) {
        if (n.level !== 0) continue
        const node = await attempt(`leaf ${n.hash}`, () => records.node(n.hash))
        if (!node || node.kind !== 'leaf') continue
        await attempt(`body of ${n.hash}`, () =>
          repo.bodyLines({ hash: n.hash, entries: node.entries as RecordEntry[] }),
        )
      }
    }
    const f = set.files
    const fr = await checkTree(`${where} files`, files, base?.files.root ?? null, f.root, (e) =>
      checkFile(e.key, e.size),
    )
    if (fr) {
      changes += fr.changes
      if (fr.count !== f.count || fr.bytes !== f.bytes)
        fail(
          `${where} files: tree has ${fr.count} / ${fr.bytes}, summary says ${f.count} / ${f.bytes}`,
        )
    }
    return changes
  }

  const setsOf = async (hash: string) => {
    const root = await repo.root(hash)
    // A public-only copy (a mirror of public sets) lacks the private set: not an error.
    const priv =
      root.private && (await repo.blobs.head(keys.privateSet(root.private)))
        ? await repo.privateSet(root.private)
        : null
    return { root, priv }
  }

  let spent = 0
  while (cursor.seq < head.seq && (spent < budget || report.versions === 0)) {
    const seq = cursor.seq + 1
    const where = `version ${seq}`
    const entry = await attempt(`log entry ${seq}`, () => readLogEntry(repo, id, seq))
    if (!entry) {
      if (report.ok) fail(`Log entry ${seq} is missing`)
      return { report, cursor: null }
    }
    const log = await attempt('log', () =>
      verifyLogEntries([entry], opts.trustedKeys, cursor.log, id),
    )
    if (!log) return { report, cursor: null }
    report.versions++
    const now = await attempt(where, () => setsOf(entry.versionHash))
    const before = cursor.versionHash
      ? await attempt(`version ${seq - 1}`, () => setsOf(cursor.versionHash!))
      : null
    if (now) {
      const pubErr = checkSetObject(now.root.public)
      if (pubErr) fail(`${where} public ${pubErr}`)
      else spent += await checkSet(`${where} public`, now.root.public, before?.root.public ?? null)
      if (now.priv) {
        const privErr = checkSetObject(now.priv, true)
        if (privErr) fail(`${where} private ${privErr}`)
        else spent += await checkSet(`${where} private`, now.priv, before?.priv ?? null)
      }
    }
    cursor = { seq, log, versionHash: entry.versionHash }
  }
  if (cursor.seq < head.seq) return { report, cursor }
  if (cursor.log?.entryHash !== head.entryHash || cursor.versionHash !== head.versionHash)
    fail('head.json does not match the last log entry')
  return { report, cursor: null }
}
