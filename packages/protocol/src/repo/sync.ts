/**
 * Tree sync: moving a version between repositories (edge-redesign-build.md,
 * "Tree sync"). Pull-only. The sender packs the objects a version reaches that
 * the receiver's base doesn't; the receiver checks every object against its key
 * before writing it, then proves the new trees canonical by re-deriving them
 * from the base, so a pack can't make it accept a tree the protocol wouldn't
 * build. Cost on both sides is O(changes × height).
 *
 * A pack is a sequence of repository objects under their keys (on the wire, a
 * tar; see tar.ts). Order: schemas, then each tree's new nodes top down with
 * each new leaf's out-of-line records and body right after it, then the private
 * set object, then the root.
 */
import {
  type Change,
  checkProtocolVersion,
  diffTrees,
  fileTree,
  hashSchema,
  jcs,
  mergeTree,
  type MergeStats,
  newNodes,
  type NodeSource,
  privateCommitment,
  type PrivateSetObject,
  type RecordEntry,
  recordTree,
  type SetObject,
  sha256Hex,
  type TreeSpec,
  type TreeSummary,
  type VersionRoot,
  versionDigest,
  versionHash,
} from '../format.js'
import { gunzipText, splitLines } from './gzip.js'
import { IntegrityError, keys, outOfLineHash, type Repo } from './repo.js'

/** Which sets a sync moves: `public`, or `all` (public and private). */
export type SyncSets = 'public' | 'all'

/** One repository object in a pack. */
export interface PackObject {
  key: string
  bytes: Uint8Array
}

export interface PackOptions {
  /** A version the receiver already has; null or absent packs everything. */
  base?: string | null
  sets?: SyncSets
}

async function raw(repo: Repo, key: string): Promise<Uint8Array> {
  const obj = await repo.blobs.get(key)
  if (!obj) throw new Error(`Missing object ${key}`)
  return obj.bytes()
}

/** A NodeSource over a repository that never reads bodies. */
const nodesOnly = <E>(repo: Repo, spec: TreeSpec<E>): NodeSource<E> => ({
  spec,
  node: (hash) => repo.decoded(spec, hash),
  async leafEntries(hash) {
    const n = await repo.decoded(spec, hash)
    if (n.kind !== 'leaf') throw new Error(`Node ${hash} is not a leaf`)
    return n.entries.slice()
  },
})

interface SetPair {
  name: 'public' | 'private'
  set: SetObject
  base: SetObject | null
  /** The base's other set, where a type that changed sets used to live. */
  other: SetObject | null
}

async function setPairs(
  repo: Repo,
  root: VersionRoot,
  base: VersionRoot | null,
  sets: SyncSets,
): Promise<{ pairs: SetPair[]; privateSet: PrivateSetObject | null }> {
  const basePrivate = sets === 'all' && base?.private ? await repo.privateSet(base.private) : null
  const pairs: SetPair[] = [
    { name: 'public', set: root.public, base: base?.public ?? null, other: basePrivate },
  ]
  let privateSet: PrivateSetObject | null = null
  if (sets === 'all' && root.private) {
    privateSet = await repo.privateSet(root.private)
    pairs.push({
      name: 'private',
      set: privateSet,
      base: basePrivate,
      other: base?.public ?? null,
    })
  }
  return { pairs, privateSet }
}

const baseTreeOf = (p: SetPair, slug: string) =>
  p.base?.types[slug]?.root ?? p.other?.types[slug]?.root ?? null

/** One tree of a version's sync work: a set's record tree of one type, or its file tree. */
export interface SyncTree {
  set: 'public' | 'private'
  kind: 'records' | 'files'
  slug: string | null
  base: string | null
  target: string | null
}

/** Everything a version's sync moves, in the order it moves it. */
export interface VersionWork {
  root: VersionRoot
  /** Keys of the schemas the base lacks. */
  schemas: string[]
  trees: SyncTree[]
  /** The private set object's key, when the private set is sent. */
  privateSet: string | null
  /** The root's key: written last. */
  rootKey: string
}

/** Plan what syncing version `target` over `opts.base` moves. */
export async function versionWork(
  repo: Repo,
  target: string,
  opts: PackOptions = {},
): Promise<VersionWork> {
  const sets = opts.sets ?? 'public'
  const root = await repo.root(target)
  const base = opts.base ? await repo.root(opts.base) : null
  const { pairs, privateSet } = await setPairs(repo, root, base, sets)
  const known = new Set<string>()
  for (const s of [base?.public, ...pairs.map((p) => p.base)]) {
    for (const t of Object.values(s?.types ?? {})) known.add(t.schema)
  }
  const schemas: string[] = []
  const trees: SyncTree[] = []
  for (const p of pairs) {
    for (const t of Object.values(p.set.types)) {
      if (known.has(t.schema)) continue
      known.add(t.schema)
      schemas.push(keys.schema(t.schema))
    }
  }
  for (const p of pairs) {
    for (const [slug, t] of Object.entries(p.set.types)) {
      trees.push({ set: p.name, kind: 'records', slug, base: baseTreeOf(p, slug), target: t.root })
    }
    trees.push({
      set: p.name,
      kind: 'files',
      slug: null,
      base: p.base?.files.root ?? null,
      target: p.set.files.root,
    })
  }
  return {
    root,
    schemas,
    trees,
    privateSet: privateSet ? keys.privateSet(root.private!) : null,
    rootKey: keys.root(target),
  }
}

/**
 * One tree's new objects, top down: nodes, and after each record leaf its
 * out-of-line records and body. `resumeKey` marks the objects after which a
 * walk can stop and resume with `after` (each leaf's last key).
 */
export async function* treeObjects(
  repo: Repo,
  tree: SyncTree,
  after: string | null = null,
): AsyncGenerator<PackObject & { resumeKey?: string }> {
  const source = tree.kind === 'records' ? nodesOnly(repo, recordTree) : nodesOnly(repo, fileTree)
  for await (const n of newNodes(source as NodeSource<unknown>, tree.base, tree.target, {
    after,
  })) {
    const node = { key: keys.node(n.hash), bytes: await raw(repo, keys.node(n.hash)) }
    if (n.level !== 0) {
      yield node
      continue
    }
    if (tree.kind === 'files') {
      yield { ...node, resumeKey: n.lastKey }
      continue
    }
    yield node
    const body = await raw(repo, keys.body(n.hash))
    for (const line of splitLines(await gunzipText(body))) {
      const h = outOfLineHash(line)
      if (h) yield { key: keys.record(h), bytes: await raw(repo, keys.record(h)) }
    }
    yield { key: keys.body(n.hash), bytes: body, resumeKey: n.lastKey }
  }
}

/** The objects version `target` reaches that `opts.base` doesn't. */
export async function* packVersion(
  repo: Repo,
  target: string,
  opts: PackOptions = {},
): AsyncGenerator<PackObject> {
  const work = await versionWork(repo, target, opts)
  for (const key of work.schemas) yield { key, bytes: await raw(repo, key) }
  for (const tree of work.trees) {
    for await (const { key, bytes } of treeObjects(repo, tree)) yield { key, bytes }
  }
  if (work.privateSet) yield { key: work.privateSet, bytes: await raw(repo, work.privateSet) }
  yield { key: work.rootKey, bytes: await raw(repo, work.rootKey) }
}

export interface ReceiveOptions {
  /** The version being received. */
  target: string
  /** The local version the pack was made against (already verified here). */
  base?: string | null
  sets?: SyncSets
}

export interface ReceiveResult {
  root: VersionRoot
  objects: number
  bytes: number
  /** Record changes from the base, over the sets received. */
  changes: { added: number; removed: number; updated: number }
}

const HEX = '([0-9a-f]{64})'
const KEY = {
  node: new RegExp(`^nodes/${HEX}$`),
  record: new RegExp(`^records/${HEX}\\.json\\.gz$`),
  body: new RegExp(`^bodies/${HEX}\\.ndjson\\.gz$`),
  schema: new RegExp(`^schemas/${HEX}\\.json$`),
  privateSet: new RegExp(`^private/${HEX}\\.json$`),
  root: new RegExp(`^roots/${HEX}\\.json$`),
}
const dec = new TextDecoder()

/** Parse canonical JSON: the bytes must be exactly the JCS of what they parse to. */
function canonical<T>(key: string, bytes: Uint8Array): T {
  const text = dec.decode(bytes)
  const value = JSON.parse(text) as T
  if (jcs(value) !== text) throw new IntegrityError(`${key} is not canonical JSON`)
  return value
}

/**
 * Receive a pack into `repo`: verify and write each object, then check that the
 * version's trees are exactly what the protocol builds. Throws IntegrityError
 * (and leaves the version unwritten) on any mismatch.
 */
export async function receiveVersion(
  repo: Repo,
  objects: AsyncIterable<PackObject> | Iterable<PackObject>,
  opts: ReceiveOptions,
): Promise<ReceiveResult> {
  const digest = versionDigest(opts.target)
  let rootBytes: Uint8Array | null = null
  let count = 0
  let total = 0
  const put = (key: string, bytes: Uint8Array, contentType: string) =>
    repo.blobs.put(key, bytes, { contentType, ifAbsent: true })

  for await (const { key, bytes } of objects) {
    count++
    total += bytes.byteLength
    try {
      rootBytes = (await receiveObject(repo, key, bytes, opts.target, digest)) ?? rootBytes
    } catch (err) {
      if (err instanceof IntegrityError) throw err
      // Undecodable gzip or JSON is a bad object too.
      throw new IntegrityError(`${key}: ${(err as Error).message}`)
    }
  }
  if (!rootBytes) throw new IntegrityError(`The pack has no root for ${opts.target}`)

  const root = JSON.parse(dec.decode(rootBytes)) as VersionRoot
  const base = opts.base ? await repo.root(opts.base) : null
  const { pairs } = await setPairs(repo, root, base, opts.sets ?? 'public')
  const changes = { added: 0, removed: 0, updated: 0 }
  for (const p of pairs) {
    for (const [slug, t] of Object.entries(p.set.types)) {
      await repo.schema(t.schema)
      const s = await checkTree(repo, recordTree, baseTreeOf(p, slug), t, `${p.name} ${slug}`)
      changes.added += s.added
      changes.removed += s.removed
      changes.updated += s.updated
    }
    await checkTree(repo, fileTree, p.base?.files.root ?? null, p.set.files, `${p.name} files`)
  }
  // Last: a reader that finds the root can read everything below it.
  await put(keys.root(opts.target), rootBytes, 'application/json')
  return { root, objects: count, bytes: total, changes }
}

/** Verify one pack object and write it; the root's bytes are returned, not written. */
async function receiveObject(
  repo: Repo,
  key: string,
  bytes: Uint8Array,
  target: string,
  digest: string,
): Promise<Uint8Array | null> {
  const put = (k: string, b: Uint8Array, contentType: string) =>
    repo.blobs.put(k, b, { contentType, ifAbsent: true })
  let m: RegExpExecArray | null
  if ((m = KEY.node.exec(key))) {
    if (sha256Hex(await gunzipText(bytes)) !== m[1])
      throw new IntegrityError(`${key} fails its hash`)
    await put(key, bytes, 'application/gzip')
  } else if ((m = KEY.record.exec(key))) {
    if (sha256Hex(await gunzipText(bytes)) !== m[1])
      throw new IntegrityError(`${key} fails its hash`)
    await put(key, bytes, 'application/gzip')
  } else if ((m = KEY.body.exec(key))) {
    // The leaf comes before its body, and its out-of-line records before it.
    const leaf = await repo.decoded(recordTree, m[1]!).catch(() => null)
    if (leaf?.kind !== 'leaf') throw new IntegrityError(`${key} arrived without its leaf`)
    await checkBody(repo, key, bytes, leaf.entries)
    await put(key, bytes, 'application/gzip')
  } else if ((m = KEY.schema.exec(key))) {
    if (hashSchema(canonical(key, bytes)) !== m[1])
      throw new IntegrityError(`${key} fails its hash`)
    await put(key, bytes, 'application/json')
  } else if ((m = KEY.privateSet.exec(key))) {
    const set = canonical<PrivateSetObject>(key, bytes)
    if (privateCommitment(set) !== m[1]) throw new IntegrityError(`${key} fails its hash`)
    await put(key, bytes, 'application/json')
  } else if ((m = KEY.root.exec(key))) {
    if (m[1] !== digest) throw new IntegrityError(`The pack holds another version's root (${key})`)
    const r = canonical<VersionRoot>(key, bytes)
    checkProtocolVersion(r)
    if (versionHash(r) !== target) throw new IntegrityError(`${key} fails its hash`)
    return bytes
  } else {
    throw new IntegrityError(`A pack can't hold ${JSON.stringify(key)}`)
  }
  return null
}

/** A body's lines, out-of-line records resolved, must hash to the leaf's entries. */
async function checkBody(
  repo: Repo,
  key: string,
  bytes: Uint8Array,
  entries: readonly RecordEntry[],
): Promise<void> {
  const lines = splitLines(await gunzipText(bytes))
  if (lines.length !== entries.length) throw new IntegrityError(`${key}: wrong line count`)
  for (let i = 0; i < lines.length; i++) {
    const ref = outOfLineHash(lines[i]!)
    let line = lines[i]!
    if (ref) {
      const rec = await repo.blobs.get(keys.record(ref))
      if (!rec) throw new IntegrityError(`${key}: out-of-line record ${ref} is missing`)
      line = await gunzipText(await rec.bytes())
    }
    if (sha256Hex(line) !== entries[i]!.hash)
      throw new IntegrityError(`${key}: line ${i} fails its hash`)
  }
}

/**
 * A received tree must be the one the protocol builds: the changes from the base
 * to it, merged into the base, give back its root, count and bytes. A record
 * tree's new leaves must also have their bodies (checked as they arrived).
 */
async function checkTree<E>(
  repo: Repo,
  spec: TreeSpec<E>,
  baseRoot: string | null,
  want: TreeSummary,
  what: string,
): Promise<MergeStats> {
  const source = nodesOnly(repo, spec)
  try {
    if (spec === (recordTree as TreeSpec<unknown>)) {
      for await (const n of newNodes(source, baseRoot, want.root)) {
        if (n.level === 0 && !(await repo.blobs.head(keys.body(n.hash)))) {
          throw new IntegrityError(`${what}: leaf ${n.hash} has no body`)
        }
      }
    }
    const changes = (async function* (): AsyncGenerator<Change<E>> {
      for await (const d of diffTrees(source, baseRoot, want.root))
        yield { key: d.key, entry: d.after }
    })()
    const merged = await mergeTree(source, { leaf() {}, interior() {} }, baseRoot, changes)
    const got = merged.root
    if (
      (got?.hash ?? null) !== want.root ||
      (got?.count ?? 0) !== want.count ||
      (got?.bytes ?? 0) !== want.bytes
    ) {
      throw new IntegrityError(`${what}: the tree is not the canonical tree of its entries`)
    }
    return merged.stats
  } catch (err) {
    if (err instanceof IntegrityError) throw err
    // Missing nodes, keys out of order, malformed nodes: all a bad pack.
    throw new IntegrityError(`${what}: ${(err as Error).message}`)
  }
}
