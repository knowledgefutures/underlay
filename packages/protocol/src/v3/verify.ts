import { parseRecordLine } from '../input-rules.js'
/**
 * Checking a sorted-record-file against docs/protocol-v3.md Section 3.7.
 *
 * The footer checks the key blocks, and each entry checks its line, so any range
 * of key blocks can be verified alone: `verifyRange` reads those key blocks and
 * the record blocks their lines sit in. `verifyFile` runs ranges side by side
 * and adds the totals up against the footer. Memory per range: one key block,
 * one record block, and the reader's windows.
 */
import { jcs } from '../jcs.js'
import type { Store } from '../repo/types.js'
import { sha256Hex } from '../sha256.js'
import { utf8 } from '../utf8.js'
import { KEY_BLOCK_ENTRIES, MAX_FILE_ENTRIES, RECORD_BLOCK_BYTES } from './constants.js'
import type { FileContent } from './file.js'
import {
  checkKey,
  compareKeys,
  type Entry,
  entryText,
  FormatError,
  parseEntry,
  recordPrefix,
  removalLine,
} from './lines.js'
import { type OpenOptions, SortedFile } from './reader.js'
import { inParallel } from './util.js'

export interface VerifyOptions extends OpenOptions {
  /**
   * Parse every record and check it is in canonical form under the input rules
   * (what a server does to an upload). Without it, a record line is checked
   * against its hash and its envelope's id and type only.
   */
  canonical?: boolean
  /** Called with every record when `canonical` is on (schema validation rides on the parse). */
  onRecord?: (type: string, id: string, data: unknown) => void
  /** Ranges verified at once. */
  concurrency?: number
  /** Key blocks per range. */
  rangeBlocks?: number
  /** Require the file to be labeled or not. */
  labeled?: boolean
}

interface RangeResult {
  entries: number
  lines: number
  records: number
  removals: number
  withheld: number
  bytes: number
  commits: [number, number] | null
  /** Where the next line after this range must start. */
  end: { block: number; offset: number }
}

const CONTENT_MEMBERS = [
  'bytes',
  'commits',
  'entries',
  'first',
  'keyBlocks',
  'labeled',
  'last',
  'lines',
  'records',
  'removals',
  'underlay',
  'withheld',
]

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isKeyPair = (v: unknown) =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string'

/** The footer is the JCS of an object with exactly the members the format lists. */
function checkFooter(f: SortedFile): void {
  const bad = (what: string) => new FormatError(`${f.key}: ${what}`)
  const { content: c, locator: l } = f
  const dec = new TextDecoder().decode(f.footer)
  if (dec !== jcs({ content: c, locator: l })) throw bad('footer is not canonical')
  if (Object.keys(c).sort().join() !== CONTENT_MEMBERS.join()) throw bad('footer members')
  if (Object.keys(l).sort().join() !== 'keyBlocks,recordBlocks') throw bad('locator members')
  if (c.underlay !== 3) throw bad('not a version 3 file')
  for (const n of [c.entries, c.lines, c.records, c.removals, c.withheld, c.bytes]) {
    if (!isCount(n)) throw bad('footer counts')
  }
  if (c.entries > MAX_FILE_ENTRIES) throw bad('too many entries')
  if (
    c.entries === 0
      ? c.first !== null || c.last !== null
      : !isKeyPair(c.first) || !isKeyPair(c.last)
  )
    throw bad('footer key range')
  if (
    c.labeled && c.entries > 0
      ? !Array.isArray(c.commits) || c.commits.length !== 2 || !c.commits.every(isCount)
      : c.commits !== null
  )
    throw bad('footer commit range')
  const want = Math.ceil(c.entries / KEY_BLOCK_ENTRIES)
  if (c.keyBlocks.length !== want) throw bad('key block count')
  c.keyBlocks.forEach((kb, i) => {
    if (!Array.isArray(kb) || kb.length !== 4 || typeof kb[2] !== 'string') throw bad('key block')
    const full = i < want - 1 ? KEY_BLOCK_ENTRIES : c.entries - (want - 1) * KEY_BLOCK_ENTRIES
    if (kb[3] !== full) throw bad(`key block ${i} entry count`)
  })
}

/**
 * The last entry before a key block that has a line, and the last entry of any
 * kind: what a range needs to know about the rows before it.
 */
async function before(
  f: SortedFile,
  block: number,
): Promise<{ prev: Entry | null; placed: Entry | null }> {
  if (block === 0) return { prev: null, placed: null }
  const reader = f.reader()
  let prev: Entry | null = null
  for (let b = block - 1; b >= 0; b--) {
    const entries = await reader.keyBlock(b)
    prev ??= entries[entries.length - 1]!
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.block !== null) return { prev, placed: entries[i]! }
    }
  }
  return { prev, placed: null }
}

/** Verify key blocks [from, to) and the lines their entries point at. */
export async function verifyRange(
  f: SortedFile,
  from: number,
  to: number,
  opts: VerifyOptions = {},
): Promise<RangeResult> {
  const bad = (what: string) => new FormatError(`${f.key}: ${what}`)
  const labeled = f.content.labeled
  const reader = f.reader({ readAhead: 1024 * 1024 })
  const blocks = f.locator.recordBlocks.length
  let { prev, placed } = await before(f, from)
  // Where the next new line must start.
  let at = { block: 0, offset: 0 }
  if (placed) {
    const end = placed.offset! + placed.size + 1
    at =
      end >= RECORD_BLOCK_BYTES
        ? { block: placed.block! + 1, offset: 0 }
        : { block: placed.block!, offset: end }
  }
  const r: RangeResult = {
    entries: 0,
    lines: 0,
    records: 0,
    removals: 0,
    withheld: 0,
    bytes: 0,
    commits: null,
    end: at,
  }
  // Strict, and with no byte-order mark dropped: the text parsed is the bytes hashed.
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  for (let b = from; b < to; b++) {
    const listed = f.content.keyBlocks[b]!
    const entries = await reader.keyBlock(b)
    const text = await reader.keyBlockText(b)
    if (entries[0]!.type !== listed[0] || entries[0]!.id !== listed[1]) {
      throw bad(`key block ${b} does not start with its listed key`)
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      if (entryText(parseEntry(text[i]!, labeled)) !== text[i]) throw bad('entry is not canonical')
      const keyError = checkKey(e.type, e.id)
      if (keyError) throw bad(keyError)
      let sameKey = false
      if (prev) {
        const c = compareKeys(prev.type, prev.id, e.type, e.id)
        sameKey = c === 0
        if (c > 0 || (sameKey && !(labeled && prev.commit! < e.commit!))) {
          throw bad(`entries out of order at ${JSON.stringify([e.type, e.id])}`)
        }
      }
      if (e.kind === 'w') {
        if (!labeled) throw bad('withheld entry in an unlabeled file')
        r.withheld++
      } else {
        const shared = sameKey && prev!.kind === e.kind && prev!.hash === e.hash
        if (shared) {
          if (e.block !== prev!.block || e.offset !== prev!.offset || e.size !== prev!.size) {
            throw bad('a row rewritten unchanged must share its line')
          }
        } else {
          if (e.block !== at.block || e.offset !== at.offset)
            throw bad('line is not where the cut rule puts it')
          if (e.block! >= blocks) throw bad('entry points past the last record block')
          const block = await reader.recordBlock(e.block!)
          const end = e.offset! + e.size
          if (end >= block.byteLength || block[end] !== 0x0a) throw bad('line has no newline')
          const line = block.subarray(e.offset!, end)
          if (e.kind === 'r') {
            if (sha256Hex(line) !== e.hash) throw bad('line does not match its hash')
            if (opts.canonical) {
              let lineText: string
              try {
                lineText = strict.decode(line)
              } catch {
                throw bad('line is not UTF-8')
              }
              const rec = parseRecordLine(lineText)
              if (rec.canonical !== lineText || rec.id !== e.id || rec.type !== e.type) {
                throw bad(`record ${JSON.stringify([e.type, e.id])} is not canonical`)
              }
              opts.onRecord?.(rec.type, rec.id, rec.data)
            } else {
              const prefix = utf8(recordPrefix(e.id, e.type))
              if (line.byteLength <= prefix.byteLength || line[line.byteLength - 1] !== 0x7d) {
                throw bad('line is not a record')
              }
              for (let k = 0; k < prefix.byteLength; k++) {
                if (line[k] !== prefix[k]) throw bad('line is not the record its entry names')
              }
            }
            r.records++
          } else {
            const want = utf8(removalLine(e.id, e.type))
            if (want.byteLength !== line.byteLength) throw bad('line is not a removal line')
            for (let k = 0; k < want.byteLength; k++) {
              if (line[k] !== want[k]) throw bad('line is not a removal line')
            }
            r.removals++
          }
          const next = end + 1
          if (next >= RECORD_BLOCK_BYTES) {
            if (next !== block.byteLength) throw bad('record block goes on past its cut')
            at = { block: e.block! + 1, offset: 0 }
          } else {
            at = { block: e.block!, offset: next }
          }
          r.lines++
          r.bytes += e.size + 1
          placed = e
        }
        if (shared) {
          if (e.kind === 'r') r.records++
          else r.removals++
        }
      }
      if (e.commit !== undefined) {
        if (!r.commits) r.commits = [e.commit, e.commit]
        else {
          if (e.commit < r.commits[0]) r.commits[0] = e.commit
          if (e.commit > r.commits[1]) r.commits[1] = e.commit
        }
      }
      r.entries++
      prev = e
    }
  }
  r.end = at
  // The last line of the file must end its record block.
  if (to === f.content.keyBlocks.length) {
    if (at.offset === 0 ? at.block !== blocks : at.block !== blocks - 1) {
      throw bad('record blocks do not end where the entries do')
    }
    if (at.offset !== 0) {
      const last = await reader.recordBlock(blocks - 1)
      if (last.byteLength !== at.offset) throw bad('bytes after the last line')
    }
    if (prev) {
      const c = f.content
      if (!c.last || c.last[0] !== prev.type || c.last[1] !== prev.id) throw bad('footer last key')
    }
  }
  return r
}

/**
 * Verify a whole file. Returns its content; the file id is `fileId(content)`,
 * or `opts.id` when given (the footer is checked against it).
 */
export async function verifyFile(
  store: Store,
  key: string,
  opts: VerifyOptions = {},
): Promise<{ id: string; content: FileContent; size: number }> {
  const f = await SortedFile.open(store, key, opts)
  const bad = (what: string) => new FormatError(`${key}: ${what}`)
  checkFooter(f)
  const c = f.content
  if (opts.labeled !== undefined && c.labeled !== opts.labeled) {
    throw bad(opts.labeled ? 'file is not labeled' : 'file is labeled')
  }
  const n = c.keyBlocks.length
  // Every byte of the object is one the footer accounts for.
  const stored = await store.head(key)
  if (stored && stored.size !== f.size) throw bad('length does not match its footer')
  if (n === 0) {
    if (
      f.locator.recordBlocks.length !== 0 ||
      c.lines !== 0 ||
      c.bytes !== 0 ||
      c.entries !== 0 ||
      c.records !== 0 ||
      c.removals !== 0 ||
      c.withheld !== 0
    ) {
      throw bad('an empty file has no blocks and counts nothing')
    }
    return { id: f.id, content: c, size: f.size }
  }
  const per = opts.rangeBlocks ?? 16
  const jobs: (() => Promise<RangeResult>)[] = []
  for (let from = 0; from < n; from += per) {
    const to = Math.min(n, from + per)
    jobs.push(() => verifyRange(f, from, to, opts))
  }
  const results = await inParallel(jobs, opts.concurrency ?? 4)
  const sum = { entries: 0, lines: 0, records: 0, removals: 0, withheld: 0, bytes: 0 }
  let commits: [number, number] | null = null
  for (const r of results) {
    sum.entries += r.entries
    sum.lines += r.lines
    sum.records += r.records
    sum.removals += r.removals
    sum.withheld += r.withheld
    sum.bytes += r.bytes
    if (r.commits) {
      commits = commits
        ? [Math.min(commits[0], r.commits[0]), Math.max(commits[1], r.commits[1])]
        : r.commits
    }
  }
  for (const k of ['entries', 'lines', 'records', 'removals', 'withheld', 'bytes'] as const) {
    if (sum[k] !== c[k]) throw bad(`footer ${k} is ${c[k]}, the file has ${sum[k]}`)
  }
  if (
    (commits?.[0] ?? null) !== (c.commits?.[0] ?? null) ||
    (commits?.[1] ?? null) !== (c.commits?.[1] ?? null)
  ) {
    throw bad('footer commit range')
  }
  const first = c.keyBlocks[0]!
  if (!c.first || c.first[0] !== first[0] || c.first[1] !== first[1]) throw bad('footer first key')
  return { id: f.id, content: c, size: f.size }
}
