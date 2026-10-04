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
import { fileTree, recordTree, type RecordEntry } from '../tree/node.js'
import { leaves } from '../tree/read.js'
import { verifyTree } from '../tree/verify.js'
import { type PublicKeyInfo, readCollectionInfo, readLogEntry, readHead, verifyLog } from './log.js'
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
