import { MAX_RECORD_BYTES } from '../constants.js'
/**
 * Reading a sorted-record-file from a store with range reads: the footer from
 * the file's tail, then only the key blocks and record blocks a read needs.
 *
 *   SortedFile    a file's footer, opened once and safe to cache (files never change)
 *   FileReader    one consumer's reads of a file, with a read-ahead window
 *   EntryCursor   a file's entries in order, with seek, for merges
 *
 * Everything read is checked on the way: the footer against the file id, a key
 * block against the footer, a line against its entry.
 */
import { jcs } from '../jcs.js'
import { readTail, type Store } from '../repo/types.js'
import { sha256Hex } from '../sha256.js'
import {
  KEY_BLOCK_ENTRIES,
  MAX_FILE_ENTRIES,
  RECORD_BLOCK_BYTES,
  TRAILER_BYTES,
  TRAILER_MAGIC,
} from './constants.js'
import type { FileContent, FileLocator } from './file.js'
import { gunzipMember } from './gz.js'
import { compareKeys, type Entry, FormatError, type Key, parseEntry } from './lines.js'

/** Bytes of a file's end read on open: the trailer, the footer, and often the key blocks. */
export const TAIL_BYTES = 65_536

export class MissingFileError extends Error {
  constructor(readonly key: string) {
    super(`Sorted-record-file ${key} is missing`)
    this.name = 'MissingFileError'
  }
}

/**
 * What a reader takes from a file before it has checked anything else: a file is someone
 * else's bytes until it is verified, and its lengths are claims. Nothing a writer under the
 * input rules produces comes near these.
 */
export const readLimits = {
  /** The footer as stored, and inflated. */
  footerStored: 16 * 1024 * 1024,
  footer: 64 * 1024 * 1024,
  /** A record block: the lines that fill it, and one more of the largest record. */
  recordBlock: RECORD_BLOCK_BYTES + MAX_RECORD_BYTES + 1,
  /** A key block: `KEY_BLOCK_ENTRIES` entries with the longest keys, escaped. */
  keyBlock: 8 * 1024 * 1024,
  /** A block as stored, past what it inflates to (gzip adds little to what it cannot shrink). */
  storedSlack: 1024 * 1024,
}

/** Strict UTF-8, with no byte-order mark dropped: what is hashed is exactly what is parsed. */
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function decode(bytes: Uint8Array, what: string): string {
  try {
    return strict.decode(bytes)
  } catch {
    throw new FormatError(`${what} is not UTF-8`)
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function prefixSums(lengths: number[], from: number): number[] {
  const out = Array.from<number>({ length: lengths.length + 1 })
  let off = from
  for (let i = 0; i < lengths.length; i++) {
    out[i] = off
    off += lengths[i]!
  }
  out[lengths.length] = off
  return out
}

export interface OpenOptions {
  /** The file id the footer must hash to. Leave out only for a file being verified. */
  id?: string
  tailBytes?: number
}

export class SortedFile {
  /** Byte offset of each record block, and one past the last. */
  readonly recordOffsets: number[]
  /** Byte offset of each key block, and one past the last. */
  readonly keyOffsets: number[]
  /** The file's length in bytes. */
  readonly size: number

  private constructor(
    readonly store: Store,
    readonly key: string,
    readonly id: string,
    readonly content: FileContent,
    readonly locator: FileLocator,
    /** The footer's uncompressed bytes, as stored. */
    readonly footer: Uint8Array,
    /** The end of the file as read on open, and where it starts. */
    readonly tail: Uint8Array,
    readonly tailOffset: number,
  ) {
    this.recordOffsets = prefixSums(locator.recordBlocks, 0)
    this.keyOffsets = prefixSums(
      locator.keyBlocks,
      this.recordOffsets[locator.recordBlocks.length]!,
    )
    this.size = tailOffset + tail.byteLength
  }

  static async open(store: Store, key: string, opts: OpenOptions = {}): Promise<SortedFile> {
    const want = opts.tailBytes ?? TAIL_BYTES
    let obj = await readTail(store, key, want)
    if (!obj) throw new MissingFileError(key)
    let tail = await obj.bytes()
    if (tail.byteLength < TRAILER_BYTES) throw new FormatError(`${key}: too short for a trailer`)
    const t = tail.subarray(tail.byteLength - TRAILER_BYTES)
    for (let i = 0; i < 8; i++) {
      if (t[i] !== TRAILER_MAGIC[i]) throw new FormatError(`${key}: bad trailer`)
    }
    const footerLength = Number(new DataView(t.buffer, t.byteOffset + 8, 8).getBigUint64(0, false))
    if (footerLength > readLimits.footerStored) throw new FormatError(`${key}: footer too long`)
    const need = footerLength + TRAILER_BYTES
    if (need > tail.byteLength) {
      if (tail.byteLength < want) throw new FormatError(`${key}: footer longer than the file`)
      obj = await readTail(store, key, need)
      if (!obj) throw new MissingFileError(key)
      tail = await obj.bytes()
      if (tail.byteLength < need) throw new FormatError(`${key}: footer longer than the file`)
    }
    const footer = await gunzipMember(
      tail.subarray(tail.byteLength - need, tail.byteLength - TRAILER_BYTES),
      readLimits.footer,
    )
    let parsed: unknown
    try {
      parsed = JSON.parse(decode(footer, `${key}: footer`))
    } catch (err) {
      throw err instanceof FormatError ? err : new FormatError(`${key}: footer is not JSON`)
    }
    if (!isObject(parsed) || !isObject(parsed.content) || !isObject(parsed.locator)) {
      throw new FormatError(`${key}: bad footer`)
    }
    const content = parsed.content as unknown as FileContent
    const locator = parsed.locator as unknown as FileLocator
    const lengths = (v: unknown, most: number, longest: number) =>
      Array.isArray(v) &&
      v.length <= most &&
      v.every((n) => Number.isSafeInteger(n) && n > 0 && n <= longest + readLimits.storedSlack)
    if (
      !lengths(locator.recordBlocks, MAX_FILE_ENTRIES, readLimits.recordBlock) ||
      !lengths(locator.keyBlocks, MAX_FILE_ENTRIES / KEY_BLOCK_ENTRIES, readLimits.keyBlock) ||
      !Array.isArray(content.keyBlocks) ||
      content.keyBlocks.length !== locator.keyBlocks.length ||
      typeof content.labeled !== 'boolean'
    ) {
      throw new FormatError(`${key}: bad footer`)
    }
    let id: string
    try {
      id = sha256Hex(jcs(content))
    } catch {
      // Nested past what canonicalizing it can walk.
      throw new FormatError(`${key}: bad footer`)
    }
    if (opts.id !== undefined && id !== opts.id) {
      throw new FormatError(`${key}: footer does not match file id ${opts.id}`)
    }
    const total =
      locator.recordBlocks.reduce((n, l) => n + l, 0) +
      locator.keyBlocks.reduce((n, l) => n + l, 0) +
      need
    // A tail shorter than asked for is the whole file.
    if (
      total < tail.byteLength ||
      (tail.byteLength < Math.max(want, need) && total !== tail.byteLength)
    ) {
      throw new FormatError(`${key}: length does not match its footer`)
    }
    return new SortedFile(store, key, id, content, locator, footer, tail, total - tail.byteLength)
  }

  /** Roughly what this object holds in memory, for a cache budget. */
  get weight(): number {
    return this.tail.byteLength + this.footer.byteLength * 3 + 1024
  }

  /**
   * The key block where a key's entries begin, if the file has any: the block
   * before the first one whose first key is at or past the key (in a labeled
   * file a key's entries can start at the end of one block and go on in the
   * next), or that block itself when the file is unlabeled and it starts with
   * the key.
   */
  blockFor(type: string, id: string): number {
    const kb = this.content.keyBlocks
    let lo = 0
    let hi = kb.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const b = kb[mid]!
      if (compareKeys(b[0], b[1], type, id) < 0) lo = mid + 1
      else hi = mid
    }
    if (lo < kb.length && !this.content.labeled) {
      const b = kb[lo]!
      if (b[0] === type && b[1] === id) return lo
    }
    return Math.max(0, lo - 1)
  }

  /** Whether the file's key range includes a key. */
  covers(type: string, id: string): boolean {
    const { first, last } = this.content
    if (!first || !last) return false
    return (
      compareKeys(first[0], first[1], type, id) <= 0 && compareKeys(type, id, last[0], last[1]) <= 0
    )
  }

  reader(opts: ReaderOptions = {}): FileReader {
    return new FileReader(this, opts)
  }
}

export interface ReaderOptions {
  /** Bytes to read past the block asked for, when the next blocks are likely wanted (scans). */
  readAhead?: number
  /** Check key blocks against the footer and lines against their entries. Default true. */
  verify?: boolean
}

interface Window {
  offset: number
  bytes: Uint8Array
}

/**
 * One consumer's view of a file. It keeps one window of compressed bytes for
 * key blocks and one for record blocks, and the last block decoded of each, so
 * a scan costs a request per window and a point read a request per block.
 * Calls made at once for the same block share one fetch: a caller reading many
 * lines in parallel (a diff page) asks for each block many times over.
 * Memory: two windows and two decoded blocks, and the blocks in flight.
 */
export class FileReader {
  readonly #readAhead: number
  readonly verify: boolean
  #keyWin: Window | null = null
  #recWin: Window | null = null
  #keyAt = -1
  #keyEntries: Entry[] = []
  #recAt = -1
  #recBytes: Uint8Array = new Uint8Array(0)
  readonly #keyPending = new Map<number, Promise<Entry[]>>()
  readonly #recPending = new Map<number, Promise<Uint8Array>>()

  constructor(
    readonly file: SortedFile,
    opts: ReaderOptions = {},
  ) {
    this.#readAhead = opts.readAhead ?? 0
    this.verify = opts.verify ?? true
  }

  /** Compressed bytes [offset, offset + length), from the tail, the window, or a new read. */
  async #range(
    win: Window | null,
    offsets: number[],
    i: number,
  ): Promise<{ bytes: Uint8Array; win: Window | null }> {
    const f = this.file
    const offset = offsets[i]!
    const end = offsets[i + 1]!
    if (offset >= f.tailOffset) {
      return { bytes: f.tail.subarray(offset - f.tailOffset, end - f.tailOffset), win }
    }
    if (win && offset >= win.offset && end <= win.offset + win.bytes.byteLength) {
      return { bytes: win.bytes.subarray(offset - win.offset, end - win.offset), win }
    }
    // Whole blocks up to the read-ahead, never past the last block of this kind.
    let j = i + 1
    const limit = offset + Math.max(this.#readAhead, end - offset)
    while (j < offsets.length - 1 && offsets[j + 1]! <= limit) j++
    const length = offsets[j]! - offset
    const obj = await f.store.get(f.key, { offset, length })
    if (!obj) throw new MissingFileError(f.key)
    const bytes = await obj.bytes()
    if (bytes.byteLength !== length) throw new FormatError(`${f.key}: short read`)
    const next = { offset, bytes }
    return { bytes: bytes.subarray(0, end - offset), win: next }
  }

  /** A key block's entries, checked against the footer. */
  async keyBlock(i: number): Promise<Entry[]> {
    if (i === this.#keyAt) return this.#keyEntries
    return shared(this.#keyPending, i, () => this.#loadKeyBlock(i))
  }

  async #loadKeyBlock(i: number): Promise<Entry[]> {
    const f = this.file
    const listed = f.content.keyBlocks[i]
    if (!listed) throw new FormatError(`${f.key}: no key block ${i}`)
    const r = await this.#range(this.#keyWin, f.keyOffsets, i)
    this.#keyWin = r.win
    const raw = await gunzipMember(r.bytes, readLimits.keyBlock)
    if (this.verify && sha256Hex(raw) !== listed[2]) {
      throw new FormatError(`${f.key}: key block ${i} does not match the footer`)
    }
    const text = decode(raw, `${f.key}: key block ${i}`)
    const lines = text.split('\n')
    if (lines.pop() !== '') throw new FormatError(`${f.key}: key block ${i} has no final newline`)
    if (lines.length !== listed[3]) throw new FormatError(`${f.key}: key block ${i} entry count`)
    const labeled = f.content.labeled
    const entries = lines.map((l) => parseEntry(l, labeled))
    this.#keyAt = i
    this.#keyEntries = entries
    return entries
  }

  /** The raw text lines of a key block, for a verifier. */
  async keyBlockText(i: number): Promise<string[]> {
    const f = this.file
    const r = await this.#range(this.#keyWin, f.keyOffsets, i)
    this.#keyWin = r.win
    const raw = await gunzipMember(r.bytes, readLimits.keyBlock)
    const lines = decode(raw, `${f.key}: key block ${i}`).split('\n')
    lines.pop()
    return lines
  }

  /** A record block's uncompressed bytes. */
  async recordBlock(i: number): Promise<Uint8Array> {
    if (i === this.#recAt) return this.#recBytes
    return shared(this.#recPending, i, () => this.#loadRecordBlock(i))
  }

  async #loadRecordBlock(i: number): Promise<Uint8Array> {
    const f = this.file
    if (i < 0 || i >= f.locator.recordBlocks.length) {
      throw new FormatError(`${f.key}: no record block ${i}`)
    }
    const r = await this.#range(this.#recWin, f.recordOffsets, i)
    this.#recWin = r.win
    const raw = await gunzipMember(r.bytes, readLimits.recordBlock)
    this.#recAt = i
    this.#recBytes = raw
    return raw
  }

  /** An entry's line, without its newline, checked against the entry's hash. */
  async line(e: Entry): Promise<Uint8Array> {
    if (e.block === null || e.offset === null) throw new FormatError('A withheld row has no line')
    const block = await this.recordBlock(e.block)
    const end = e.offset + e.size
    if (end >= block.byteLength || block[end] !== 0x0a || e.offset >= RECORD_BLOCK_BYTES) {
      throw new FormatError(`${this.file.key}: entry points outside its record block`)
    }
    const line = block.subarray(e.offset, end)
    if (this.verify && e.kind === 'r' && sha256Hex(line) !== e.hash) {
      throw new FormatError(`${this.file.key}: line does not match its entry's hash`)
    }
    return line
  }

  /** Every entry with a key, in commit order (one at most in an unlabeled file). */
  lookup(type: string, id: string): Promise<Entry[]> {
    return lookupEntries(this.file, type, id, (i) => this.keyBlock(i))
  }
}

/** One fetch per key at a time: callers asking while it is in flight wait for the same one. */
function shared<T>(
  pending: Map<number, Promise<T>>,
  i: number,
  load: () => Promise<T>,
): Promise<T> {
  let p = pending.get(i)
  if (!p) {
    p = load().finally(() => pending.delete(i))
    pending.set(i, p)
  }
  return p
}

/**
 * Every entry a file has for a key, in commit order, given a way to get a key
 * block. A caller that looks up many keys at once passes a getter that fetches
 * each block once.
 */
export async function lookupEntries(
  f: SortedFile,
  type: string,
  id: string,
  keyBlock: (i: number) => Promise<Entry[]>,
): Promise<Entry[]> {
  if (!f.covers(type, id)) return []
  const out: Entry[] = []
  const kb = f.content.keyBlocks
  for (let i = f.blockFor(type, id); i < kb.length; i++) {
    if (i > 0 && out.length === 0 && compareKeys(kb[i]![0], kb[i]![1], type, id) > 0) break
    const entries = await keyBlock(i)
    let lo = 0
    let hi = entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const e = entries[mid]!
      if (compareKeys(e.type, e.id, type, id) < 0) lo = mid + 1
      else hi = mid
    }
    let j = lo
    for (; j < entries.length; j++) {
      const e = entries[j]!
      if (e.type !== type || e.id !== id) break
      out.push(e)
    }
    // The key's entries go on in the next block only if they ran to this one's end.
    if (j < entries.length) break
  }
  return out
}

/**
 * A file's entries in key order, one key block in memory at a time. Each entry
 * carries a commit: its own in a labeled file, or the one the cursor was given
 * (the commit that named an unlabeled file).
 */
export class EntryCursor {
  #block = -1
  #entries: Entry[] = []
  #pos = 0
  current: Entry | null = null

  constructor(
    readonly reader: FileReader,
    /** The commit every row of an unlabeled file counts as written by. */
    readonly commit: number | null,
  ) {
    if (reader.file.content.labeled === (commit !== null)) {
      throw new Error(
        commit === null ? 'An unlabeled file needs a commit' : 'A labeled file has its own',
      )
    }
  }

  #set(): void {
    const e = this.#entries[this.#pos]
    if (!e) {
      this.current = null
      return
    }
    this.current = this.commit === null ? e : { ...e, commit: this.commit }
  }

  /** Move to the first entry at or after a key; with no key, to the file's first entry. */
  async seek(key?: Key): Promise<void> {
    const f = this.reader.file
    const n = f.content.keyBlocks.length
    if (n === 0) {
      this.current = null
      return
    }
    let b = key ? f.blockFor(key.type, key.id) : 0
    for (; b < n; b++) {
      const entries = await this.reader.keyBlock(b)
      let lo = 0
      if (key) {
        let hi = entries.length
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          const e = entries[mid]!
          if (compareKeys(e.type, e.id, key.type, key.id) < 0) lo = mid + 1
          else hi = mid
        }
      }
      if (lo < entries.length) {
        this.#block = b
        this.#entries = entries
        this.#pos = lo
        this.#set()
        return
      }
    }
    this.#block = n
    this.#entries = []
    this.current = null
  }

  async next(): Promise<void> {
    this.#pos++
    if (this.#pos >= this.#entries.length) {
      const n = this.reader.file.content.keyBlocks.length
      if (this.#block + 1 >= n) {
        this.#block = n
        this.#entries = []
        this.current = null
        return
      }
      this.#block++
      this.#entries = await this.reader.keyBlock(this.#block)
      this.#pos = 0
    }
    this.#set()
  }
}
