/**
 * Checking a collection's log (docs/protocol-v3.md, Sections 4 and 9): the chain of
 * commits, and, given keys, who signed each, by its own signature or by its receipt.
 */
import { jcs } from '../jcs.js'
import type { Store } from '../repo/types.js'
import { readReceipt, verifyReceipt } from './author.js'
import { recordKey } from './build.js'
import { FormatError } from './lines.js'
import {
  commitFiles,
  headNumber,
  nextSemver,
  readLog,
  sameVersion,
  type StoredCommit,
  verifyChange,
  verifyCommit,
  versionHex,
} from './log.js'
import { SortedFile } from './reader.js'
import type { PublicKeyInfo } from './sign.js'

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
  /**
   * With `serverKeys`: a commit the author built, which carries no server signature, counts
   * as signed when its receipt (Section 4.7) is signed by one of them.
   */
  receipts?: boolean
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
    if (
      wantPrev !== undefined &&
      (wantPrev === null ? c.commit.previous !== null : !sameVersion(c.commit.previous, wantPrev))
    )
      throw bad('previous does not match')
    for (const ch of c.commit.changes) {
      // A base is a version of this log before the commit. What it names is recorded as
      // given: nothing requires it to be the commit before.
      if (ch.base !== null && from === 1 && !seen.has(versionHex(ch.base) ?? ch.base)) {
        throw bad(`base ${ch.base} is not an earlier version of this collection`)
      }
      if (opts.authorKeys && !(await verifyChange(ch, opts.authorKeys))) {
        throw bad('a change is not signed by an accepted author key')
      }
    }
    if (opts.serverKeys && !(await verifyCommit(c.commit, opts.serverKeys))) {
      const receipt = opts.receipts ? await readReceipt(store, collection, n) : null
      if (!receipt || !(await verifyReceipt(receipt, c, opts.serverKeys)))
        throw bad('neither the commit nor its receipt is signed by an accepted server key')
    }
    seen.add(versionHex(c.id)!)
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
