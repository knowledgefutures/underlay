/**
 * Commits built by their author, and the receipts an authority signs beside them
 * (docs/protocol-v3.md, Sections 4.6 and 4.7; federation.md F13).
 *
 * Each collection names one authority, the only server that accepts its versions. The
 * author builds the whole commit: it names the version it follows (`previous`), so its
 * number and semver are settled before it is sent, and its id is the hash of the commit
 * as built. The authority stores it unchanged when `previous` is still its newest, and
 * signs a receipt beside it ("accepted as number N at this time"). So the same version has
 * the same id on the author's machine and on every server that holds it.
 *
 * If another commit got there first, the author replays its commits on the new newest:
 * the changes stay as they were, and only the commit's own part (number, previous, semver,
 * time) is made again, as when a server-built change loses the race for a number (4.2).
 */
import { jcs } from '../jcs.js'
import { createObject, type Store } from '../repo/types.js'
import type { BumpType } from '../semver.js'
import { utf8 } from '../utf8.js'
import type { FileRef } from './file.js'
import { FormatError } from './lines.js'
import {
  type Change,
  type Commit,
  commitBytes,
  commitFiles,
  commitKey,
  isVersionId,
  nextSemver,
  notBefore,
  parseCommit,
  type StoredCommit,
  versionId,
} from './log.js'
import { type PublicKeyInfo, type Signer, signObject, verifyObject } from './sign.js'

/** What an author needs of the commit it follows: null for a collection's first. */
export type Previous = Pick<StoredCommit, 'id'> & {
  commit: Pick<Commit, 'number' | 'semver'> & Partial<Pick<Commit, 'createdAt'>>
}

export interface BuildCommitInput {
  collection: string
  previous: Previous | null
  /** The change, as `makeChange` makes it. */
  change: Change
  bump: BumpType
  createdAt?: Date
}

/**
 * Build a commit as its author: the number and semver follow from `previous` and the
 * bump. Unsigned unless a signer is given (the author's key; a server that holds no
 * authors' keys refuses a signed one).
 */
export async function buildCommit(i: BuildCommitInput, signer?: Signer): Promise<StoredCommit> {
  if (i.change.collection !== i.collection)
    throw new FormatError(`The change is for ${i.change.collection}, not ${i.collection}`)
  const unsigned: Commit = {
    underlay: 3,
    collection: i.collection,
    number: (i.previous?.commit.number ?? 0) + 1,
    previous: i.previous?.id ?? null,
    semver: nextSemver(i.previous?.commit.semver ?? null, i.bump),
    // Never before the commit it follows (4.6): an authority refuses a time that goes back.
    createdAt: notBefore(i.createdAt ?? new Date(), i.previous?.commit.createdAt).toISOString(),
    changes: [i.change],
    keyId: null,
    sig: null,
  }
  const commit = signer ? await signObject(unsigned, signer) : unsigned
  const bytes = commitBytes(commit)
  // A commit no reader takes would end the log: built only if it reads back.
  parseCommit(bytes)
  return { commit, id: versionId(bytes), bytes }
}

/**
 * The kind of change a commit is, by the rule a server applies to an upload (4.4): major
 * if it changes the schema set, minor if any file holds a publisher row, else patch. A
 * file holds publisher rows exactly when its first or last key's type is not reserved.
 */
export function commitBump(files: FileRef[], schemaChanged: boolean): BumpType {
  if (schemaChanged) return 'major'
  const ordinary = files.some(
    (f) => (f.first && !f.first[0].startsWith('$')) || (f.last && !f.last[0].startsWith('$')),
  )
  return ordinary ? 'minor' : 'patch'
}

/**
 * Commits built on a version that is no longer the newest, built again on `onto`, in
 * order. Each change stays as it was, except a `base` that named one of the commits being
 * replayed, which names its replayed id. `bump` gives each commit's kind of change against
 * what it now follows (a schema row may no longer change anything). Returns the new
 * commits and a map from each old version id to its new one.
 */
export async function replayCommits(
  commits: StoredCommit[],
  onto: Previous | null,
  bump: (c: StoredCommit, previous: Previous | null) => BumpType | Promise<BumpType>,
  now: () => Date = () => new Date(),
): Promise<{ commits: StoredCommit[]; ids: Map<string, string> }> {
  const out: StoredCommit[] = []
  const ids = new Map<string, string>()
  let previous = onto
  for (const c of commits) {
    if (c.commit.changes.length !== 1) throw new FormatError('Only a commit of one change replays')
    const ch = c.commit.changes[0]!
    const change: Change = { ...ch, base: ch.base === null ? null : (ids.get(ch.base) ?? ch.base) }
    const next = await buildCommit({
      collection: c.commit.collection,
      previous,
      change,
      bump: await bump(c, previous),
      createdAt: now(),
    })
    ids.set(c.id, next.id)
    out.push(next)
    previous = next
  }
  return { commits: out, ids }
}

export interface AuthorCommitCheck {
  /** The authority's newest commit, or null. */
  head: Previous | null
  /** The files the upload brought, as the commit must name them. */
  files: FileRef[]
  /** The kind of change the authority found the files to be. */
  bump: BumpType
  /** When the commit was asked for, and how far `createdAt` may be from it. */
  now: Date
  skewMs?: number
}

/** How far an author's clock may be from the authority's. */
export const CREATED_AT_SKEW_MS = 10 * 60 * 1000

/**
 * Check an author-built commit against the authority's newest: the next number, after
 * the newest id, with the semver its rows call for, a time near now and not before the
 * newest's, one unsigned change naming exactly the upload's files. Returns the commit, or
 * `{stale}` when another commit got there first (the author replays and tries again), or
 * the problem.
 *
 * Not checked here, since it needs the log: that the change's `base` is a version of the
 * collection. The authority checks it before storing the commit (`findVersion`), as
 * `createCommit` does for a commit it builds; `verifyLog` refuses a log with any other.
 */
export function checkAuthorCommit(
  bytes: Uint8Array,
  collection: string,
  check: AuthorCommitCheck,
): { commit: Commit; id: string } | { stale: true } | { problem: string } {
  let commit: Commit
  try {
    commit = parseCommit(bytes)
  } catch (err) {
    if (err instanceof FormatError) return { problem: err.message }
    throw err
  }
  if (commit.collection !== collection) return { problem: `The commit is for ${commit.collection}` }
  const wantNumber = (check.head?.commit.number ?? 0) + 1
  if (commit.number !== wantNumber || commit.previous !== (check.head?.id ?? null)) {
    // Built on a version that is not the newest: either the author is behind (the usual
    // case) or it names a number past the newest, which is never right.
    if (commit.number > wantNumber) return { problem: `Commit ${commit.number} skips a number` }
    return { stale: true }
  }
  if (commit.keyId !== null || commit.sig !== null)
    return { problem: 'A signed commit is not accepted yet: send it unsigned' }
  if (commit.changes.length !== 1) return { problem: 'A commit carries one change' }
  const ch = commit.changes[0]!
  if (ch.keyId !== null || ch.sig !== null)
    return { problem: 'A signed change is not accepted yet: send it unsigned' }
  if (jcs(ch.files) !== jcs(check.files))
    return { problem: "The commit's change must name exactly the upload's files" }
  if (ch.base !== null && !isVersionId(ch.base)) return { problem: 'Bad base' }
  const semver = nextSemver(check.head?.commit.semver ?? null, check.bump)
  if (commit.semver !== semver)
    return { problem: `The semver is ${semver} for this change, not ${commit.semver}` }
  const at = Date.parse(commit.createdAt)
  if (
    !Number.isFinite(at) ||
    new Date(at).toISOString() !== commit.createdAt ||
    Math.abs(at - check.now.getTime()) > (check.skewMs ?? CREATED_AT_SKEW_MS)
  )
    return { problem: `createdAt ${commit.createdAt} is not near the time it was sent` }
  const before = check.head?.commit.createdAt
  if (before !== undefined && at < Date.parse(before))
    return { problem: `createdAt ${commit.createdAt} is before the version it follows (${before})` }
  return { commit, id: versionId(bytes) }
}

/**
 * A receipt: the authority's word that it accepted a version as number N, at a time,
 * signed by its key. It sits beside the commit (`commits/<n>.receipt.json`), never inside
 * what is hashed, so the version id does not depend on the host.
 */
export interface Receipt {
  underlay: 3
  collection: string
  number: number
  version: string
  receivedAt: string
  /** Who signs it: the server, by its address (`underlay.org`). */
  server: string
  keyId: string | null
  sig: string | null
}

export const receiptKey = (collection: string, number: number) =>
  commitKey(collection, number).replace(/\.json$/, '.receipt.json')

export async function makeReceipt(
  stored: StoredCommit,
  server: string,
  signer: Signer | null,
  receivedAt: Date = new Date(),
): Promise<Receipt> {
  const r: Receipt = {
    underlay: 3,
    collection: stored.commit.collection,
    number: stored.commit.number,
    version: stored.id,
    receivedAt: receivedAt.toISOString(),
    server,
    keyId: null,
    sig: null,
  }
  return signer ? signObject(r, signer) : r
}

const RECEIPT_MEMBERS = 'collection,keyId,number,receivedAt,server,sig,underlay,version'

export function parseReceipt(text: string): Receipt {
  let r: unknown
  try {
    r = JSON.parse(text)
  } catch {
    throw new FormatError('Receipt is not JSON')
  }
  const o = r as Record<string, unknown>
  if (
    !o ||
    typeof o !== 'object' ||
    Object.keys(o).sort().join() !== RECEIPT_MEMBERS ||
    o.underlay !== 3 ||
    typeof o.collection !== 'string' ||
    !Number.isSafeInteger(o.number) ||
    !isVersionId(o.version) ||
    typeof o.receivedAt !== 'string' ||
    typeof o.server !== 'string' ||
    !(o.keyId === null || typeof o.keyId === 'string') ||
    !(o.sig === null || typeof o.sig === 'string')
  )
    throw new FormatError('Bad receipt')
  return o as unknown as Receipt
}

/**
 * Write a commit's receipt, once: a receipt already there stands. `holder` is the
 * collection whose log holds the commit, when that is not the one the commit was made for
 * (a fork's earlier commits carry its parent's id, and so do their receipts).
 */
export async function writeReceipt(
  store: Store,
  r: Receipt,
  holder: string = r.collection,
): Promise<boolean> {
  return createObject(store, receiptKey(holder, r.number), utf8(jcs(r)), {
    contentType: 'application/json',
  })
}

export async function readReceipt(
  store: Store,
  collection: string,
  number: number,
): Promise<Receipt | null> {
  const obj = await store.get(receiptKey(collection, number))
  return obj ? parseReceipt(await obj.text()) : null
}

/** Is this the receipt of this commit, signed by one of these keys? */
export async function verifyReceipt(
  r: Receipt,
  stored: StoredCommit,
  keys: PublicKeyInfo[],
): Promise<boolean> {
  return (
    r.collection === stored.commit.collection &&
    r.number === stored.commit.number &&
    r.version === stored.id &&
    verifyObject(r, keys)
  )
}

/** The files of commits, each once, in the order they are first named. */
export function filesOf(commits: StoredCommit[]): FileRef[] {
  const seen = new Set<string>()
  const out: FileRef[] = []
  for (const c of commits)
    for (const f of commitFiles(c.commit)) if (!seen.has(f.id) && seen.add(f.id)) out.push(f)
  return out
}
