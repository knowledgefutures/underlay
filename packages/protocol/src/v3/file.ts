/**
 * The sorted-record-file (docs/protocol-v3.md, Section 3): record blocks, key
 * blocks, a footer, and a trailer. This is the content side and the writer: what
 * the format fixes, so that the same rows give the same file id on any machine.
 *
 *   ContentBuilder     entries in, positions and key blocks out; no bytes of lines
 *   SortedFileWriter   rows in, the file's bytes out to a sink, a block at a time
 */
import { jcs } from '../jcs.js'
import { sha256Hex } from '../sha256.js'
import { utf8 } from '../utf8.js'
import {
  KEY_BLOCK_ENTRIES,
  MAX_FILE_ENTRIES,
  RECORD_BLOCK_BYTES,
  TRAILER_BYTES,
  TRAILER_MAGIC,
} from './constants.js'
import { concatBytes, gzipMember } from './gz.js'
import { compareKeys, type Entry, entryText, FormatError, type Kind } from './lines.js'

export type KeyPair = [type: string, id: string]

/** The hashed part of a footer: only what the rows determine. */
export interface FileContent {
  underlay: 3
  labeled: boolean
  entries: number
  lines: number
  records: number
  removals: number
  withheld: number
  /** Total uncompressed size of the record blocks. */
  bytes: number
  first: KeyPair | null
  last: KeyPair | null
  commits: [number, number] | null
  /** Each key block's first key, the SHA-256 of its uncompressed bytes, and its entry count. */
  keyBlocks: [type: string, id: string, hash: string, entries: number][]
}

/** The unhashed part of a footer: compressed block lengths, which depend on the compressor. */
export interface FileLocator {
  recordBlocks: number[]
  keyBlocks: number[]
}

/** How a commit names a file: its id and what a reader needs before opening it. */
export interface FileRef {
  id: string
  first: KeyPair | null
  last: KeyPair | null
  entries: number
  records: number
  removals: number
  bytes: number
}

export const fileId = (content: FileContent): string => sha256Hex(jcs(content))

export function fileRef(id: string, c: FileContent): FileRef {
  return {
    id,
    first: c.first,
    last: c.last,
    entries: c.entries,
    records: c.records,
    removals: c.removals,
    bytes: c.bytes,
  }
}

/** Where `ContentBuilder.add` put an entry's line. */
export interface Placed {
  /** The entry has a line of its own (not shared with the entry before, not withheld). */
  newLine: boolean
  /** That line closed its record block. */
  closesBlock: boolean
}

/**
 * Builds a file's content from its entries in order: assigns each line its block
 * and offset by the cut rule, shares a line between entries that the format says
 * share one, and seals key blocks. It never sees a line's bytes, so a rebuild can
 * learn a file's id from key entries alone, before copying any record.
 */
export class ContentBuilder {
  readonly #keyBlocks: FileContent['keyBlocks'] = []
  #sealed: Uint8Array[] = []
  #text: string[] = []
  #blockFirst: KeyPair | null = null
  #block = 0
  #offset = 0
  #prev: Entry | null = null
  #first: KeyPair | null = null
  #commits: [number, number] | null = null
  entries = 0
  lines = 0
  records = 0
  removals = 0
  withheld = 0
  bytes = 0

  constructor(readonly labeled: boolean) {}

  add(
    kind: Kind,
    type: string,
    id: string,
    hash: string | null,
    size: number,
    commit?: number,
  ): Placed {
    if (this.entries >= MAX_FILE_ENTRIES) throw new FormatError('Too many entries for one file')
    if (this.labeled !== (commit !== undefined)) {
      throw new FormatError(this.labeled ? 'A labeled file needs commits' : 'Unexpected commit')
    }
    if (kind === 'w' && !this.labeled) throw new FormatError('Withheld rows need a labeled file')
    const prev = this.#prev
    let sameKey = false
    if (prev) {
      const c = compareKeys(prev.type, prev.id, type, id)
      sameKey = c === 0
      if (c > 0 || (sameKey && !(this.labeled && prev.commit! < commit!))) {
        throw new FormatError(`Rows out of order at ${JSON.stringify([type, id])}`)
      }
    }
    const e: Entry = { kind, type, id, hash, size, block: null, offset: null }
    if (commit !== undefined) e.commit = commit
    const placed: Placed = { newLine: false, closesBlock: false }
    if (kind !== 'w') {
      if (sameKey && prev!.kind === kind && prev!.hash === hash) {
        e.block = prev!.block
        e.offset = prev!.offset
      } else {
        e.block = this.#block
        e.offset = this.#offset
        placed.newLine = true
        this.lines++
        this.bytes += size + 1
        this.#offset += size + 1
        if (this.#offset >= RECORD_BLOCK_BYTES) {
          placed.closesBlock = true
          this.#block++
          this.#offset = 0
        }
      }
    }
    if (kind === 'r') this.records++
    else if (kind === 'x') this.removals++
    else this.withheld++
    if (commit !== undefined) {
      if (!this.#commits) this.#commits = [commit, commit]
      else {
        if (commit < this.#commits[0]) this.#commits[0] = commit
        if (commit > this.#commits[1]) this.#commits[1] = commit
      }
    }
    if (!this.#first) this.#first = [type, id]
    if (this.#text.length === 0) this.#blockFirst = [type, id]
    this.#text.push(entryText(e))
    this.entries++
    this.#prev = e
    if (this.#text.length === KEY_BLOCK_ENTRIES) this.#seal()
    return placed
  }

  #seal(): void {
    const bytes = utf8(this.#text.join('\n') + '\n')
    const [type, id] = this.#blockFirst!
    this.#keyBlocks.push([type, id, sha256Hex(bytes), this.#text.length])
    this.#sealed.push(bytes)
    this.#text = []
  }

  /** Key blocks sealed since the last call, uncompressed, in order. */
  takeKeyBlocks(): Uint8Array[] {
    const out = this.#sealed
    this.#sealed = []
    return out
  }

  /** Seal the last key block and give the content. `takeKeyBlocks` then has the rest. */
  finish(): FileContent {
    if (this.#text.length > 0) this.#seal()
    const prev = this.#prev
    return {
      underlay: 3,
      labeled: this.labeled,
      entries: this.entries,
      lines: this.lines,
      records: this.records,
      removals: this.removals,
      withheld: this.withheld,
      bytes: this.bytes,
      first: this.#first,
      last: prev ? [prev.type, prev.id] : null,
      commits: this.#commits,
      keyBlocks: this.#keyBlocks,
    }
  }
}

/** A row for a writer: a line with its key, or a withheld row (no line). */
export type WriteRow =
  | {
      kind: 'r' | 'x'
      type: string
      id: string
      /** The canonical line, without its newline. */
      line: Uint8Array | string
      /** The line's hash, if the caller already has it (a rebuild copying a verified line). */
      hash?: string | null
      commit?: number
    }
  | { kind: 'w'; type: string; id: string; hash: string; size: number; commit: number }

export interface FileSink {
  write(chunk: Uint8Array): Promise<void>
}

export interface WrittenFile {
  id: string
  content: FileContent
  /** The file's length as written, in bytes. */
  size: number
}

export interface WriterOptions {
  labeled?: boolean
  /** Gzip level where zlib is native. It does not change the file id. */
  level?: number
  /** Blocks compressed at once. */
  concurrency?: number
}

const NL = new Uint8Array([0x0a])

export function footerBytes(content: FileContent, locator: FileLocator): Uint8Array {
  return utf8(jcs({ content, locator }))
}

export function trailerBytes(footerLength: number): Uint8Array {
  const out = new Uint8Array(TRAILER_BYTES)
  out.set(TRAILER_MAGIC, 0)
  new DataView(out.buffer).setBigUint64(8, BigInt(footerLength), false)
  return out
}

/**
 * Writes one sorted-record-file from rows in key order. Record blocks go to the
 * sink as they fill; key blocks are held compressed (about 50 bytes an entry)
 * and follow at the end with the footer and trailer. The file id is known only
 * when `finish` returns, so the sink writes somewhere it can be named afterwards.
 */
export class SortedFileWriter {
  readonly #content: ContentBuilder
  readonly #level: number | undefined
  readonly #concurrency: number
  #chunks: Uint8Array[] = []
  #chunkBytes = 0
  #pending: Promise<Uint8Array>[] = []
  #keyGz: Promise<Uint8Array>[] = []
  readonly #recordLengths: number[] = []
  #size = 0

  constructor(
    readonly sink: FileSink,
    opts: WriterOptions = {},
  ) {
    this.#content = new ContentBuilder(opts.labeled ?? false)
    this.#level = opts.level
    this.#concurrency = opts.concurrency ?? 4
  }

  get entries(): number {
    return this.#content.entries
  }
  /** Uncompressed bytes of lines so far. */
  get bytes(): number {
    return this.#content.bytes
  }

  async add(row: WriteRow): Promise<void> {
    if (row.kind === 'w') {
      this.#content.add('w', row.type, row.id, row.hash, row.size, row.commit)
    } else {
      const line = typeof row.line === 'string' ? utf8(row.line) : row.line
      const hash = row.kind === 'x' ? null : (row.hash ?? sha256Hex(line))
      const placed = this.#content.add(
        row.kind,
        row.type,
        row.id,
        hash,
        line.byteLength,
        row.commit,
      )
      if (placed.newLine) {
        this.#chunks.push(line, NL)
        this.#chunkBytes += line.byteLength + 1
        if (placed.closesBlock) await this.#closeBlock()
      }
    }
    for (const kb of this.#content.takeKeyBlocks()) this.#keyGz.push(gzipMember(kb, this.#level))
  }

  async #closeBlock(): Promise<void> {
    const raw = concatBytes(this.#chunks, this.#chunkBytes)
    this.#chunks = []
    this.#chunkBytes = 0
    this.#pending.push(gzipMember(raw, this.#level))
    while (this.#pending.length >= this.#concurrency) await this.#drainOne()
  }

  async #drainOne(): Promise<void> {
    const gz = await this.#pending.shift()!
    this.#recordLengths.push(gz.byteLength)
    await this.#write(gz)
  }

  async #write(bytes: Uint8Array): Promise<void> {
    this.#size += bytes.byteLength
    await this.sink.write(bytes)
  }

  async finish(): Promise<WrittenFile> {
    if (this.#chunkBytes > 0) await this.#closeBlock()
    while (this.#pending.length > 0) await this.#drainOne()
    const content = this.#content.finish()
    for (const kb of this.#content.takeKeyBlocks()) this.#keyGz.push(gzipMember(kb, this.#level))
    const keyLengths: number[] = []
    for (const p of this.#keyGz) {
      const gz = await p
      keyLengths.push(gz.byteLength)
      await this.#write(gz)
    }
    const footer = await gzipMember(
      footerBytes(content, { recordBlocks: this.#recordLengths, keyBlocks: keyLengths }),
      this.#level,
    )
    await this.#write(footer)
    await this.#write(trailerBytes(footer.byteLength))
    return { id: fileId(content), content, size: this.#size }
  }
}

/** A sink that keeps the file in memory (small files, tests). */
export class MemorySink implements FileSink {
  readonly chunks: Uint8Array[] = []
  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk)
  }
  bytes(): Uint8Array {
    return concatBytes(this.chunks.length > 0 ? this.chunks : [new Uint8Array(0)])
  }
}

/** Write rows, already in key order, as one file in memory. */
export async function writeFileBytes(
  rows: Iterable<WriteRow> | AsyncIterable<WriteRow>,
  opts: WriterOptions = {},
): Promise<WrittenFile & { bytes: Uint8Array }> {
  const sink = new MemorySink()
  const w = new SortedFileWriter(sink, opts)
  for await (const row of rows) await w.add(row)
  const written = await w.finish()
  return { ...written, bytes: sink.bytes() }
}
