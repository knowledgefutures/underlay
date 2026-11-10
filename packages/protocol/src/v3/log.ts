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
import { inParallel } from './util.js'

export interface Change {
  files: FileRef[]
  message: string | null
  by: string | null
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
  keyId: string | null
  sig: string | null
}

/** A file as a layout lists it. */
export interface LayoutFile extends FileRef {
  labeled: boolean
  /** The commits whose rows it holds; `[c, c]` for a commit's own (unlabeled) file. */
  commits: [number, number]
  /** Reference server: the layout that wrote it; 0 for a commit's own file. */
  run?: number
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

/** `latest.json`: where to start looking for the newest commit and layout. May be stale. */
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
    !nullOrString(c.keyId) ||
    !nullOrString(c.sig)
  ) {
    throw new FormatError('Bad commit')
  }
  const files: FileRef[] = []
  for (const ch of c.changes as unknown[]) {
    if (
      !isObject(ch) ||
      !Array.isArray(ch.files) ||
      !nullOrString(ch.message) ||
      !nullOrString(ch.by)
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

export async function readLatest(store: Store, collection: string): Promise<Latest | null> {
  const obj = await store.get(latestKey(collection))
  if (!obj) return null
  try {
    const l = JSON.parse(await obj.text()) as Partial<Latest>
    if (isNumber(l.commit) && isNumber(l.layout)) return { commit: l.commit, layout: l.layout }
  } catch {
    // A hint that does not parse is no hint.
  }
  return null
}

/** Overwrite the hint. It is only a hint: a failed write (a rate limit) is ignored. */
export async function writeLatest(store: Store, collection: string, latest: Latest): Promise<void> {
  await store.put(latestKey(collection), jcs(latest)).catch(() => {})
}

/**
 * The highest number that exists, given that `from` does (0 if none is known
 * to): gallop upward, then bisect. Numbers have no gaps. A fresh hint costs one
 * probe; a stale or missing one, a few more.
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
  const hint = latest === undefined ? await readLatest(store, collection) : latest
  const exists = async (n: number) => (await store.head(commitKey(collection, n))) !== null
  let from = hint?.commit ?? 0
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

/** The newest layout, or null. */
export async function findLayout(
  store: Store,
  collection: string,
  latest?: Latest | null,
): Promise<Layout | null> {
  const hint = latest === undefined ? await readLatest(store, collection) : latest
  const exists = async (n: number) => (await store.head(layoutKey(collection, n))) !== null
  let from = hint?.layout ?? 0
  if (from > 0 && !(await exists(from))) from = 0
  const n = await probeUp(exists, from)
  if (n === 0) return null
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
  files: FileRef[]
  message?: string | null
  by?: string | null
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
  const latest = await readLatest(store, collection)
  // The hinted commit, if it is there; the create below finds out whether it is the newest.
  let head: StoredCommit | null = null
  if (latest && latest.commit > 0) head = await readCommit(store, collection, latest.commit)
  if (!head && latest?.commit !== 0) head = await findHead(store, collection, null)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const bump = typeof input.bump === 'function' ? await input.bump(head) : input.bump
    const commit: Commit = {
      underlay: 3,
      collection,
      number: (head?.commit.number ?? 0) + 1,
      previous: head?.id ?? null,
      semver: nextSemver(head?.commit.semver ?? null, bump),
      createdAt: (opts.now?.() ?? new Date()).toISOString(),
      changes: [{ files: input.files, message: input.message ?? null, by: input.by ?? null }],
      keyId: null,
      sig: null,
    }
    const bytes = commitBytes(commit)
    const key = commitKey(collection, commit.number)
    const won = await createObject(store, key, bytes, { contentType: 'application/json' })
    const mine = { commit, id: versionId(bytes), bytes }
    if (won) {
      await writeLatest(store, collection, { commit: commit.number, layout: latest?.layout ?? 0 })
      return mine
    }
    // Lost, or a retried request that had in fact won: see what holds the number.
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
export async function createLayout(
  store: Store,
  layout: Layout,
  latest?: Latest | null,
): Promise<boolean> {
  checkCollectionId(layout.collection)
  const won = await createObject(store, layoutKey(layout.collection, layout.number), jcs(layout), {
    contentType: 'application/json',
  })
  if (won) {
    const hint = latest === undefined ? await readLatest(store, layout.collection) : latest
    await writeLatest(store, layout.collection, {
      commit: Math.max(hint?.commit ?? 0, layout.through),
      layout: layout.number,
    })
  }
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
  from?: number
  /** The version id `from`'s `previous` must be, when `from` is above 1. */
  previous?: string
}

/**
 * Check the chain: numbers without gaps, each commit canonical, naming the
 * commit before it by version id, carrying the right collection id, and with a
 * semver that follows from the one before. Returns the head.
 */
export async function verifyLog(
  store: Store,
  collection: string,
  opts: VerifyLogOptions = {},
): Promise<StoredCommit | null> {
  const head = await headNumber(store, collection)
  const from = opts.from ?? 1
  let prev: StoredCommit | null = null
  for await (const c of readLog(store, collection, from, head)) {
    const n = c.commit.number
    const bad = (what: string) => new FormatError(`Commit ${n} of ${collection}: ${what}`)
    const owner = opts.lineage?.find(([, through]) => n <= through)?.[0] ?? collection
    if (c.commit.collection !== owner) throw bad(`carries collection ${c.commit.collection}`)
    const wantPrev = prev ? prev.id : n === 1 ? null : opts.previous
    if (wantPrev !== undefined && c.commit.previous !== wantPrev)
      throw bad('previous does not match')
    if (prev) {
      const ok = (['major', 'minor', 'patch'] as const).some(
        (b) => nextSemver(prev!.commit.semver, b) === c.commit.semver,
      )
      if (!ok) throw bad(`semver ${c.commit.semver} does not follow ${prev.commit.semver}`)
    } else if (n === 1 && c.commit.semver !== 'v1.0.0') throw bad('the first commit is v1.0.0')
    if (opts.files) {
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
