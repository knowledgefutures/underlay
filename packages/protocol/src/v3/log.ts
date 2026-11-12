/**
 * Commits, layout files, and the log (docs/protocol-v3.md, Sections 4, 5, 9).
 *
 * A commit is a small numbered object, created only if its number is free, that
 * names the sorted-record-files one upload added and the commit before it. A
 * layout file is the same kind of object for rebuilds. Nothing here reads a
 * collection's records: making a commit costs the same whatever the collection
 * holds.
 */
import { jcs } from '../jcs.js'
import { createObject, type Store } from '../repo/types.js'
import { type BumpType, parseSemver } from '../semver.js'
import { sha256Hex } from '../sha256.js'
import { utf8 } from '../utf8.js'
import { recordKey } from './build.js'
import { NUMBER_WIDTH, VERSION_ID_PREFIX } from './constants.js'
import type { FileRef, KeyPair } from './file.js'
import { compareKeys, FormatError } from './lines.js'
import { SortedFile } from './reader.js'
import { type PublicKeyInfo, type Signer, signObject, verifyObject } from './sign.js'
import { inParallel } from './util.js'

/**
 * What an author sends: the files of one upload, for one collection, with the
 * version they were working from. The author signs it (`keyId`, `sig`, over the
 * change without `sig`); the signature does not cover where the change lands.
 */
export interface Change {
  collection: string
  files: FileRef[]
  /** The version id the author was working from, or null. Recorded, never enforced. */
  base: string | null
  message: string | null
  /** The author's key and signature; both null for an unsigned change. */
  keyId: string | null
  sig: string | null
}

export interface Commit {
  underlay: 3
  collection: string
  number: number
  /** The version id of the commit before, null for the first. */
  previous: string | null
  semver: string
  createdAt: string
  changes: Change[]
  /** The server's key and signature, over the whole commit without this `sig`. */
  keyId: string | null
  sig: string | null
}

/** A file as a layout lists it. */
export interface LayoutFile extends FileRef {
  labeled: boolean
  /** The commits whose rows it holds; `[c, c]` for a commit's own (unlabeled) file. */
  commits: [number, number]
  /** Reference server: a number shared by the files one merge wrote; 0 for a commit's own file. */
  group?: number
  /** Reference server: the file's stored size in bytes. */
  size?: number
}

export interface Layout {
  underlay: 3
  collection: string
  number: number
  /** Every row written by commits 1 to `through` that a retained version sees is in `files`. */
  through: number
  createdAt: string
  files: LayoutFile[]
  /** Ranges of commit numbers still readable at or below `through`; absent means all. */
  retained?: [number, number][]
}

/**
 * Where to start looking for the newest commit and layout. May be stale. Kept as
 * two objects, `latest.json` for the commit and `latest-layout.json` for the
 * layout, so that each has one writer: a committer and a rebuild never overwrite
 * each other's hint, or one key twice in a second.
 */
export interface Latest {
  commit: number
  layout: number
}

export interface StoredCommit {
  commit: Commit
  /** The version id: `ulv3:` and the SHA-256 of the commit's bytes. */
  id: string
  bytes: Uint8Array
}

const COLLECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export function checkCollectionId(id: string): void {
  if (!COLLECTION_ID.test(id)) throw new FormatError(`Bad collection id: ${JSON.stringify(id)}`)
}

const num = (n: number) => String(n).padStart(NUMBER_WIDTH, '0')
export const collectionPrefix = (collection: string) => `collections/${collection}/`
export const descriptionKey = (c: string) => `${collectionPrefix(c)}collection.json`
export const commitKey = (c: string, n: number) => `${collectionPrefix(c)}commits/${num(n)}.json`
export const layoutKey = (c: string, n: number) => `${collectionPrefix(c)}layouts/${num(n)}.json`
export const latestKey = (c: string) => `${collectionPrefix(c)}latest.json`
export const layoutHintKey = (c: string) => `${collectionPrefix(c)}latest-layout.json`

export const commitBytes = (commit: Commit): Uint8Array => utf8(jcs(commit))
export const versionId = (bytes: Uint8Array): string => VERSION_ID_PREFIX + sha256Hex(bytes)

const dec = new TextDecoder()
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isKeyPair = (v: unknown): v is KeyPair =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string'
const nullOrString = (v: unknown) => v === null || typeof v === 'string'
const VERSION_ID = /^ulv3:[0-9a-f]{64}$/
/** Whether a string has the shape of a version id. */
export const isVersionId = (v: unknown): v is string => typeof v === 'string' && VERSION_ID.test(v)

/** The members of a file entry as a commit is written with (Section 4). */
const FILE_REF_MEMBERS = 'bytes,entries,first,id,last,records,removals'

function checkFileRef(f: unknown, what: string): asserts f is FileRef {
  if (
    !isObject(f) ||
    typeof f.id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(f.id) ||
    !(f.first === null ? f.last === null : isKeyPair(f.first) && isKeyPair(f.last)) ||
    ![f.entries, f.records, f.removals, f.bytes].every(isNumber)
  ) {
    throw new FormatError(`${what}: bad file entry`)
  }
}

/** Parse a commit's bytes, checking they are the canonical form of a well-shaped commit. */
export function parseCommit(bytes: Uint8Array): Commit {
  const text = dec.decode(bytes)
  let c: unknown
  try {
    c = JSON.parse(text)
  } catch {
    throw new FormatError('Commit is not JSON')
  }
  if (!isObject(c) || jcs(c) !== text) throw new FormatError('Commit is not canonical JSON')
  const members = 'changes,collection,createdAt,keyId,number,previous,semver,sig,underlay'
  if (Object.keys(c).sort().join() !== members) throw new FormatError('Commit members')
  if (
    c.underlay !== 3 ||
    typeof c.collection !== 'string' ||
    !isNumber(c.number) ||
    c.number < 1 ||
    !(c.number === 1 ? c.previous === null : typeof c.previous === 'string') ||
    typeof c.semver !== 'string' ||
    !/^v\d+\.\d+\.\d+$/.test(c.semver) ||
    typeof c.createdAt !== 'string' ||
    !Array.isArray(c.changes) ||
    !(c.number === 1 || isVersionId(c.previous)) ||
    !nullOrString(c.keyId) ||
    !nullOrString(c.sig) ||
    (c.keyId === null) !== (c.sig === null) ||
    (c.changes as unknown[]).length === 0
  ) {
    throw new FormatError('Bad commit')
  }
  const files: FileRef[] = []
  for (const ch of c.changes as unknown[]) {
    if (
      !isObject(ch) ||
      Object.keys(ch).sort().join() !== 'base,collection,files,keyId,message,sig' ||
      ch.collection !== c.collection ||
      !Array.isArray(ch.files) ||
      !(ch.base === null || isVersionId(ch.base)) ||
      !nullOrString(ch.message) ||
      !nullOrString(ch.keyId) ||
      !nullOrString(ch.sig) ||
      (ch.keyId === null) !== (ch.sig === null)
    ) {
      throw new FormatError('Bad commit change')
    }
    for (const f of ch.files as unknown[]) {
      checkFileRef(f, 'Commit')
      files.push(f)
    }
  }
  // Within one commit the files' key ranges do not overlap.
  const ranged = files.filter((f) => f.first).sort((a, b) => cmp(a.first!, b.first!))
  for (let i = 1; i < ranged.length; i++) {
    if (cmp(ranged[i - 1]!.last!, ranged[i]!.first!) >= 0) {
      throw new FormatError('Commit names files whose key ranges overlap')
    }
  }
  return c as unknown as Commit
}

const cmp = (a: KeyPair, b: KeyPair) => compareKeys(a[0], a[1], b[0], b[1])

/** Every file a commit names, across its changes. */
export const commitFiles = (c: Commit): FileRef[] => c.changes.flatMap((ch) => ch.files)

export function parseLayout(bytes: Uint8Array): Layout {
  let l: unknown
  try {
    l = JSON.parse(dec.decode(bytes))
  } catch {
    throw new FormatError('Layout is not JSON')
  }
  if (
    !isObject(l) ||
    l.underlay !== 3 ||
    typeof l.collection !== 'string' ||
    !isNumber(l.number) ||
    l.number < 1 ||
    !isNumber(l.through) ||
    !Array.isArray(l.files)
  ) {
    throw new FormatError('Bad layout')
  }
  for (const f of l.files as unknown[]) {
    checkFileRef(f, 'Layout')
    const lf = f as unknown as Record<string, unknown>
    if (
      typeof lf.labeled !== 'boolean' ||
      !Array.isArray(lf.commits) ||
      lf.commits.length !== 2 ||
      !lf.commits.every(isNumber)
    ) {
      throw new FormatError('Layout: bad file entry')
    }
  }
  if (
    l.retained !== undefined &&
    !(
      Array.isArray(l.retained) &&
      l.retained.every((r) => Array.isArray(r) && r.length === 2 && r.every(isNumber))
    )
  ) {
    throw new FormatError('Layout: bad retained')
  }
  return l as unknown as Layout
}

export async function readCommit(
  store: Store,
  collection: string,
  number: number,
): Promise<StoredCommit | null> {
  const obj = await store.get(commitKey(collection, number))
  if (!obj) return null
  const bytes = await obj.bytes()
  const commit = parseCommit(bytes)
  if (commit.number !== number) throw new FormatError(`Commit ${number} carries another number`)
  return { commit, id: versionId(bytes), bytes }
}

export async function readLayout(
  store: Store,
  collection: string,
  number: number,
): Promise<Layout | null> {
  const obj = await store.get(layoutKey(collection, number))
  if (!obj) return null
  const layout = parseLayout(await obj.bytes())
  if (layout.number !== number) throw new FormatError(`Layout ${number} carries another number`)
  return layout
}

async function readHint(store: Store, key: string, member: string): Promise<number | null> {
  const obj = await store.get(key)
  if (!obj) return null
  try {
    const n = (JSON.parse(await obj.text()) as Record<string, unknown>)[member]
    return isNumber(n) ? n : null
  } catch {
    // A hint that does not parse is no hint.
    return null
  }
}

/** The hinted newest commit number, or null. */
export const readCommitHint = (store: Store, collection: string) =>
  readHint(store, latestKey(collection), 'commit')
/** The hinted newest layout number, or null. */
export const readLayoutHint = (store: Store, collection: string) =>
  readHint(store, layoutHintKey(collection), 'layout')

/** Both hints, or null if the collection has neither. */
export async function readLatest(store: Store, collection: string): Promise<Latest | null> {
  const [commit, layout] = await Promise.all([
    readCommitHint(store, collection),
    readLayoutHint(store, collection),
  ])
  if (commit === null && layout === null) return null
  return { commit: commit ?? 0, layout: layout ?? 0 }
}

/** Overwrite a hint. It is only a hint: a failed write (a rate limit) is ignored. */
export async function writeCommitHint(store: Store, collection: string, commit: number) {
  await store.put(latestKey(collection), jcs({ commit })).catch(() => {})
}
export async function writeLayoutHint(store: Store, collection: string, layout: number) {
  await store.put(layoutHintKey(collection), jcs({ layout })).catch(() => {})
}
export async function writeLatest(store: Store, collection: string, latest: Latest): Promise<void> {
  await writeCommitHint(store, collection, latest.commit)
  if (latest.layout > 0) await writeLayoutHint(store, collection, latest.layout)
}

/**
 * The highest number that exists, given that `from` does (0 if none is known
 * to): gallop upward, then bisect. Numbers have no gaps from `from` up: commits
 * are never deleted, and a server that deletes old layout files keeps the layout
 * hint on one that exists (`readLayoutAtHint`). A fresh hint costs one probe; a
 * stale or missing one, a few more.
 */
export async function probeUp(
  exists: (n: number) => Promise<boolean>,
  from: number,
): Promise<number> {
  let lo = from
  let step = 1
  while (await exists(lo + step)) {
    lo += step
    step *= 2
  }
  let hi = lo + step
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (await exists(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/** The number of the newest commit (0 if none), from the hint and probes. */
export async function headNumber(
  store: Store,
  collection: string,
  latest?: Latest | null,
): Promise<number> {
  const hinted = latest === undefined ? await readCommitHint(store, collection) : latest?.commit
  const exists = async (n: number) => (await store.head(commitKey(collection, n))) !== null
  let from = hinted ?? 0
  // A hint is never ahead of the log, unless it outlived a deleted collection.
  if (from > 0 && !(await exists(from))) from = 0
  return probeUp(exists, from)
}

/** The newest commit, or null for a collection with none. */
export async function findHead(
  store: Store,
  collection: string,
  latest?: Latest | null,
): Promise<StoredCommit | null> {
  const n = await headNumber(store, collection, latest)
  if (n === 0) return null
  const head = await readCommit(store, collection, n)
  if (!head) throw new Error(`Commit ${n} of ${collection} vanished`)
  return head
}

/**
 * The layout a hint names. A server may delete old layout files once the hint names a
 * newer one, so a hinted layout that is gone means the hint is stale: it is read again,
 * and if it still names none, the layouts are listed (probing up from 1 would find the
 * low numbers gone and take the collection to have no layout).
 */
export async function readLayoutAtHint(
  store: Store,
  collection: string,
  hinted: number | null | undefined,
): Promise<Layout | null> {
  if (!hinted || hinted < 1) return null
  const layout = await readLayout(store, collection, hinted)
  if (layout) return layout
  const again = await readLayoutHint(store, collection)
  const named = again && again !== hinted ? await readLayout(store, collection, again) : null
  if (named) return named
  const prefix = `${collectionPrefix(collection)}layouts/`
  let newest = 0
  let cursor: string | undefined
  do {
    const page = await store.list(prefix, cursor)
    for (const key of page.keys) {
      const n = Number.parseInt(key.slice(prefix.length), 10)
      if (n > newest) newest = n
    }
    cursor = page.cursor
  } while (cursor !== undefined)
  return newest > 0 ? readLayout(store, collection, newest) : null
}

/** The newest layout, or null. */
export async function findLayout(
  store: Store,
  collection: string,
  latest?: Latest | null,
): Promise<Layout | null> {
  const hinted = latest === undefined ? await readLayoutHint(store, collection) : latest?.layout
  const exists = async (n: number) => (await store.head(layoutKey(collection, n))) !== null
  const from = await readLayoutAtHint(store, collection, hinted)
  const n = await probeUp(exists, from?.number ?? 0)
  if (n === 0) return null
  if (n === from?.number) return from
  const layout = await readLayout(store, collection, n)
  if (!layout) throw new Error(`Layout ${n} of ${collection} vanished`)
  return layout
}

/** The semver after `previous` for a kind of change; the first commit is v1.0.0. */
export function nextSemver(previous: string | null, bump: BumpType): string {
  if (previous === null) return 'v1.0.0'
  const { major, minor, patch } = parseSemver(previous)
  if (bump === 'major') return `v${major + 1}.0.0`
  if (bump === 'minor') return `v${major}.${minor + 1}.0`
  return `v${major}.${minor}.${patch + 1}`
}

export interface CommitInput {
  /**
   * The change to commit: one the author prepared (and signed) with `makeChange`,
   * or its parts, from which an unsigned change is made here.
   */
  change?: Change
  files?: FileRef[]
  base?: string | null
  message?: string | null
  /** Where the base is in the log, if the caller knows: saves the search for it. */
  baseNumber?: number
  /**
   * What kind of change this is, for the semver: a value, or a function of the
   * commit it would follow (asked again if another commit lands first).
   */
  bump: BumpType | ((head: StoredCommit | null) => Promise<BumpType> | BumpType)
}

export interface CommitOptions {
  now?: () => Date
  /** Times to try again after losing the number to another committer. */
  attempts?: number
  /** The server's key: signs the whole commit where it lands. */
  signer?: Signer
  /** If given, the change must be signed by one of these keys. */
  authorKeys?: PublicKeyInfo[]
  /** Commits to look back through for a base whose number was not given. Default 1,000. */
  baseSearch?: number
}

/**
 * Make a change, as its author: the files of one upload and the version worked
 * from. With a signer it is signed; the signature stays valid wherever the
 * change lands in the log.
 */
export async function makeChange(
  collection: string,
  parts: { files: FileRef[]; base?: string | null; message?: string | null },
  signer?: Signer,
): Promise<Change> {
  const change: Change = {
    collection,
    // As a commit names a file: what a builder adds (its stored size, say) is left out.
    files: parts.files.map((f) => ({
      id: f.id,
      first: f.first,
      last: f.last,
      entries: f.entries,
      records: f.records,
      removals: f.removals,
      bytes: f.bytes,
    })),
    base: parts.base ?? null,
    message: parts.message ?? null,
    keyId: null,
    sig: null,
  }
  return signer ? signObject(change, signer) : change
}

/** Does one of these keys sign the change (the author) or the commit (the server)? */
export const verifyChange = (change: Change, keys: PublicKeyInfo[]) => verifyObject(change, keys)
export const verifyCommit = (commit: Commit, keys: PublicKeyInfo[]) => verifyObject(commit, keys)

export class BaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BaseError'
  }
}

/**
 * The number of the commit with a version id, looking back from `from`; null if
 * it is not among the `search` commits before it. A fork's log holds the
 * commits of the collections it came from, so its lineage is found the same way.
 */
export async function findVersion(
  store: Store,
  collection: string,
  id: string,
  from: number,
  opts: { hint?: number; search?: number } = {},
): Promise<number | null> {
  if (opts.hint !== undefined && opts.hint >= 1 && opts.hint <= from) {
    const c = await readCommit(store, collection, opts.hint)
    if (c?.id === id) return opts.hint
  }
  const stop = Math.max(1, from - (opts.search ?? 1000) + 1)
  for (let n = from; n >= stop; n--) {
    const c = await readCommit(store, collection, n)
    if (!c) return null
    if (c.id === id) return n
    // Each commit names the one before it, so the walk needs only every other read.
    if (c.commit.previous === id) return n - 1
  }
  return null
}

export class CommitRaceError extends Error {
  constructor(collection: string, attempts: number) {
    super(`Lost the race to commit to ${collection} ${attempts} times`)
    this.name = 'CommitRaceError'
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i])

/**
 * Create the next commit of a collection. The commit's number is claimed by
 * creating its object only if absent; a committer that loses takes the next
 * number, so no upload is lost and no two commits share a number.
 *
 * Requests when uncontended: read the hint, read the head commit, create the
 * commit, write the hint.
 */
export async function createCommit(
  store: Store,
  collection: string,
  input: CommitInput,
  opts: CommitOptions = {},
): Promise<StoredCommit> {
  checkCollectionId(collection)
  const attempts = opts.attempts ?? 50
  const change =
    input.change ??
    (await makeChange(collection, {
      files: input.files ?? [],
      base: input.base ?? null,
      message: input.message ?? null,
    }))
  if (change.collection !== collection) {
    throw new BaseError(`The change is for collection ${change.collection}, not ${collection}`)
  }
  if (opts.authorKeys && !(await verifyChange(change, opts.authorKeys))) {
    throw new BaseError('The change is not signed by a key this collection accepts')
  }
  let baseChecked = change.base === null
  const hinted = await readCommitHint(store, collection)
  // The hinted commit, if it is there; the create below finds out whether it is the newest.
  let head: StoredCommit | null = null
  if (hinted !== null && hinted > 0) head = await readCommit(store, collection, hinted)
  if (!head && hinted !== 0) head = await findHead(store, collection, null)
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!baseChecked) {
      // The base is recorded as given, but it has to be a version of this collection or of
      // the collections it was forked from. Newer commits never make it invalid, so once.
      const find = async (from: StoredCommit | null) =>
        from && from.id === change.base
          ? from.commit.number
          : from
            ? findVersion(store, collection, change.base!, from.commit.number, {
                ...(input.baseNumber === undefined ? {} : { hint: input.baseNumber }),
                ...(opts.baseSearch === undefined ? {} : { search: opts.baseSearch }),
              })
            : null
      let at = await find(head)
      if (at === null) {
        // The hint may be stale, and the base newer than the commit it pointed at: look again
        // from the true head before refusing.
        const newest = await findHead(store, collection, {
          commit: head?.commit.number ?? 0,
          layout: 0,
        })
        if (newest && newest.commit.number !== head?.commit.number) {
          head = newest
          at = await find(head)
        }
      }
      if (at === null) {
        throw new BaseError(`Base ${change.base} is not a version of ${collection}`)
      }
      baseChecked = true
    }
    const bump = typeof input.bump === 'function' ? await input.bump(head) : input.bump
    const unsigned: Commit = {
      underlay: 3,
      collection,
      number: (head?.commit.number ?? 0) + 1,
      previous: head?.id ?? null,
      semver: nextSemver(head?.commit.semver ?? null, bump),
      createdAt: (opts.now?.() ?? new Date()).toISOString(),
      // The author's change goes in as it came, signature and all, at whatever number is free.
      changes: [change],
      keyId: null,
      sig: null,
    }
    const commit = opts.signer ? await signObject(unsigned, opts.signer) : unsigned
    const bytes = commitBytes(commit)
    // Written only if it can be read back: a commit no reader takes would end the log, since
    // nothing can be committed after one that cannot be read.
    try {
      parseCommit(bytes)
      for (const f of change.files) {
        if (Object.keys(f).sort().join() !== FILE_REF_MEMBERS)
          throw new FormatError(`File entry ${f.id} has members a commit does not name`)
      }
    } catch (err) {
      if (err instanceof FormatError)
        throw new BaseError(`The change cannot be committed: ${err.message}`)
      throw err
    }
    const key = commitKey(collection, commit.number)
    const won = await createObject(store, key, bytes, { contentType: 'application/json' })
    const mine = { commit, id: versionId(bytes), bytes }
    if (won) {
      await writeCommitHint(store, collection, commit.number)
      return mine
    }
    // Lost, or a retried request that had in fact won: see what holds the number. The
    // same bytes there mean the same files after the same commit at the same moment,
    // which is this commit whoever's request wrote it.
    const there = await readCommit(store, collection, commit.number)
    if (!there)
      throw new Error(`Commit ${commit.number} of ${collection} was refused but is absent`)
    if (sameBytes(there.bytes, bytes)) return mine
    // Catch up to the newest before trying again; under contention it may be far ahead.
    head = (await findHead(store, collection, { commit: commit.number, layout: 0 })) ?? there
  }
  throw new CommitRaceError(collection, attempts)
}

/** Create the next layout; false if another rebuild took the number first. */
export async function createLayout(store: Store, layout: Layout): Promise<boolean> {
  checkCollectionId(layout.collection)
  const won = await createObject(store, layoutKey(layout.collection, layout.number), jcs(layout), {
    contentType: 'application/json',
  })
  if (won) await writeLayoutHint(store, layout.collection, layout.number)
  return won
}

/** Commits `from` to `to` inclusive, in order, read a few at a time. */
export async function* readLog(
  store: Store,
  collection: string,
  from: number,
  to: number,
  concurrency = 16,
): AsyncGenerator<StoredCommit> {
  for (let at = from; at <= to; at += concurrency) {
    const batch = await inParallel(
      Array.from({ length: Math.min(concurrency, to - at + 1) }, (_, i) => async () => {
        const c = await readCommit(store, collection, at + i)
        if (!c) throw new Error(`Commit ${at + i} of ${collection} is missing`)
        return c
      }),
      concurrency,
    )
    yield* batch
  }
}

export interface VerifyLogOptions {
  /**
   * The collection ids commits may carry, each with the last commit number that
   * carries it: a fork's earlier commits carry the ids of the collections it
   * came from. Default: every commit carries `collection`.
   */
  lineage?: [collection: string, through: number][]
  /** Also open each file a commit names and check its footer against the commit. */
  files?: boolean
  /**
   * With `files`: only for commits from this number on. A rebuild's layout replaces the
   * files of the commits it covers, and the sweep then removes them, so a server checks the
   * files of the commits after its newest layout and the layout's own files apart.
   */
  filesFrom?: number
  from?: number
  /** The version id `from`'s `previous` must be, when `from` is above 1. */
  previous?: string
  /** If given, every commit must be signed by one of these keys (the server's). */
  serverKeys?: PublicKeyInfo[]
  /** If given, every change must be signed by one of these keys (authors'). */
  authorKeys?: PublicKeyInfo[]
}

/**
 * Check the chain: numbers without gaps, each commit canonical, naming the
 * commit before it by version id, carrying the right collection id, with a
 * semver that follows from the one before, each base an earlier version, and,
 * given keys, signed by the server and by its author. Returns the head.
 */
export async function verifyLog(
  store: Store,
  collection: string,
  opts: VerifyLogOptions = {},
): Promise<StoredCommit | null> {
  const head = await headNumber(store, collection)
  const from = opts.from ?? 1
  let prev: StoredCommit | null = null
  const seen = new Set<string>()
  for await (const c of readLog(store, collection, from, head)) {
    const n = c.commit.number
    const bad = (what: string) => new FormatError(`Commit ${n} of ${collection}: ${what}`)
    const owner = opts.lineage?.find(([, through]) => n <= through)?.[0] ?? collection
    if (c.commit.collection !== owner) throw bad(`carries collection ${c.commit.collection}`)
    const wantPrev = prev ? prev.id : n === 1 ? null : opts.previous
    if (wantPrev !== undefined && c.commit.previous !== wantPrev)
      throw bad('previous does not match')
    for (const ch of c.commit.changes) {
      // A base is a version of this log before the commit. What it names is recorded as
      // given: nothing requires it to be the commit before.
      if (ch.base !== null && from === 1 && !seen.has(ch.base)) {
        throw bad(`base ${ch.base} is not an earlier version of this collection`)
      }
      if (opts.authorKeys && !(await verifyChange(ch, opts.authorKeys))) {
        throw bad('a change is not signed by an accepted author key')
      }
    }
    if (opts.serverKeys && !(await verifyCommit(c.commit, opts.serverKeys))) {
      throw bad('the commit is not signed by an accepted server key')
    }
    seen.add(c.id)
    if (prev) {
      const ok = (['major', 'minor', 'patch'] as const).some(
        (b) => nextSemver(prev!.commit.semver, b) === c.commit.semver,
      )
      if (!ok) throw bad(`semver ${c.commit.semver} does not follow ${prev.commit.semver}`)
    } else if (n === 1 && c.commit.semver !== 'v1.0.0') throw bad('the first commit is v1.0.0')
    if (opts.files && n >= (opts.filesFrom ?? 1)) {
      for (const f of commitFiles(c.commit)) {
        const file = await SortedFile.open(store, recordKey(f.id), { id: f.id })
        const fc = file.content
        if (
          fc.labeled ||
          fc.entries !== f.entries ||
          fc.records !== f.records ||
          fc.removals !== f.removals ||
          fc.bytes !== f.bytes ||
          jcs(fc.first) !== jcs(f.first) ||
          jcs(fc.last) !== jcs(f.last)
        ) {
          throw bad(`file ${f.id} is not as the commit describes it`)
        }
      }
    }
    prev = c
  }
  return prev
}
