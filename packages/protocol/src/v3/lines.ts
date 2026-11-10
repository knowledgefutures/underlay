/**
 * Lines, keys, and entries (docs/protocol-v3.md, Sections 2 and 3.2).
 *
 * A sorted-record-file holds record lines (v2's canonical record, so record
 * hashes are v2's) and removal lines. Each line has an entry in the file's key
 * blocks: its kind, key, hash, size, and where it sits.
 */
import { MAX_RECORD_BYTES } from '../constants.js'
import { MAX_JSON_DEPTH } from '../constants.js'
import { recordCanonical } from '../hash.js'
import { checkRecordId, checkTypeSlug, InputRuleError, parseStrict } from '../input-rules.js'
import { compareUtf8, utf8ByteLength } from '../utf8.js'
import { ASSET_TYPE, META_ID, META_TYPE, RESERVED_TYPES, SCHEMA_TYPE } from './constants.js'

/** `r`: a record line. `x`: a removal line. `w`: a record whose line is withheld. */
export type Kind = 'r' | 'x' | 'w'

export interface Key {
  type: string
  id: string
}

/** One entry of a key block. `commit` is present in labeled files only. */
export interface Entry extends Key {
  kind: Kind
  /** The line's SHA-256, hex; null for a removal. */
  hash: string | null
  /** The line's length in bytes, without its newline. */
  size: number
  /** The record block holding the line, and the line's offset in it; null when withheld. */
  block: number | null
  offset: number | null
  commit?: number
}

/** Key order: by type, then id, each as UTF-8 bytes (v2 Section 7). */
export function compareKeys(aType: string, aId: string, bType: string, bId: string): number {
  return aType === bType ? compareUtf8(aId, bId) : compareUtf8(aType, bType)
}
export const compareKey = (a: Key, b: Key) => compareKeys(a.type, a.id, b.type, b.id)

export const recordLine = recordCanonical

export function removalLine(id: string, type: string): string {
  return '{"id":' + JSON.stringify(id) + ',"removed":true,"type":' + JSON.stringify(type) + '}'
}

/** An entry as it is written in a key block: JCS of its array. */
export function entryText(e: Entry): string {
  return (
    '["' +
    e.kind +
    '",' +
    JSON.stringify(e.type) +
    ',' +
    JSON.stringify(e.id) +
    ',' +
    (e.hash === null ? 'null' : '"' + e.hash + '"') +
    ',' +
    e.size +
    ',' +
    (e.block === null ? 'null' : e.block) +
    ',' +
    (e.offset === null ? 'null' : e.offset) +
    (e.commit === undefined ? '' : ',' + e.commit) +
    ']'
  )
}

export class FormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormatError'
  }
}

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const HEX64 = /^[0-9a-f]{64}$/

/** Parse one entry line of a key block, checking its shape (not its key's validity). */
export function parseEntry(text: string, labeled: boolean): Entry {
  let a: unknown
  try {
    a = JSON.parse(text)
  } catch {
    throw new FormatError('Entry is not JSON')
  }
  if (!Array.isArray(a) || a.length !== (labeled ? 8 : 7)) throw new FormatError('Bad entry')
  const [kind, type, id, hash, size, block, offset, commit] = a as unknown[]
  if (kind !== 'r' && kind !== 'x' && kind !== 'w') throw new FormatError('Bad entry kind')
  if (typeof type !== 'string' || typeof id !== 'string') throw new FormatError('Bad entry key')
  if (kind === 'x' ? hash !== null : typeof hash !== 'string' || !HEX64.test(hash))
    throw new FormatError('Bad entry hash')
  if (!isCount(size)) throw new FormatError('Bad entry size')
  if (kind === 'w' ? block !== null || offset !== null : !isCount(block) || !isCount(offset))
    throw new FormatError('Bad entry position')
  const e: Entry = {
    kind,
    type,
    id,
    hash: hash as string | null,
    size,
    block: block as number | null,
    offset: offset as number | null,
  }
  if (labeled) {
    if (!isCount(commit) || commit < 1) throw new FormatError('Bad entry commit')
    e.commit = commit
  }
  return e
}

/** Whether a type and id may be a key: v2's limits, and only the three reserved `$` types. */
export function checkKey(type: unknown, id: unknown): string | null {
  const typeError = checkTypeSlug(type)
  if (typeError) return typeError
  const idError = checkRecordId(id)
  if (idError) return idError
  const t = type as string
  const i = id as string
  if (!t.startsWith('$')) return null
  if (!RESERVED_TYPES.includes(t)) return `Type "${t}" is reserved`
  if (t === SCHEMA_TYPE) {
    return i.startsWith('$') || checkTypeSlug(i) ? '$schema id must be a type name' : null
  }
  if (t === ASSET_TYPE) return HEX64.test(i) ? null : '$asset id must be a SHA-256 in hex'
  if (t === META_TYPE) return i === META_ID ? null : `$meta id must be "${META_ID}"`
  return null
}

/** A row as a writer takes it: a key and its canonical line. */
export interface LineRow extends Key {
  kind: 'r' | 'x'
  /** The canonical line, without its newline. */
  line: string
}

/**
 * Parse one line of an upload under the input rules: a record
 * `{"id":…,"type":…,"data":…}` or a removal `{"id":…,"type":…,"removed":true}`.
 * Gives the canonical line, which is what is stored and hashed.
 */
export function parseInputLine(text: string): LineRow & { data?: unknown } {
  const value = parseStrict(text, MAX_JSON_DEPTH + 1)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputRuleError('bad_envelope', 'Line must be a JSON object')
  }
  const rec = value as Record<string, unknown>
  const keyError = checkKey(rec.type, rec.id)
  if (keyError) {
    throw new InputRuleError(checkRecordId(rec.id) === keyError ? 'bad_id' : 'bad_type', keyError)
  }
  const id = rec.id as string
  const type = rec.type as string
  const members = Object.keys(rec).length
  if ('removed' in rec) {
    if (rec.removed !== true || members !== 3) {
      throw new InputRuleError('bad_envelope', 'A removal is {"id","type","removed":true}')
    }
    return { kind: 'x', type, id, line: removalLine(id, type) }
  }
  if (!('data' in rec) || members !== 3) {
    throw new InputRuleError('bad_envelope', 'A record is {"id","type","data"}')
  }
  const line = recordCanonical(id, type, rec.data)
  if (utf8ByteLength(line) > MAX_RECORD_BYTES) {
    throw new InputRuleError('record_too_large', `Record exceeds ${MAX_RECORD_BYTES} bytes`)
  }
  return { kind: 'r', type, id, line, data: rec.data }
}

/**
 * A row from a record a builder already holds as values (not as a line of
 * text): its key is checked and its data put in canonical form.
 */
export function rowFromRecord(id: string, type: string, data: unknown): LineRow {
  const keyError = checkKey(type, id)
  if (keyError) {
    throw new InputRuleError(checkRecordId(id) === keyError ? 'bad_id' : 'bad_type', keyError)
  }
  const line = recordCanonical(id, type, data)
  if (utf8ByteLength(line) > MAX_RECORD_BYTES) {
    throw new InputRuleError('record_too_large', `Record exceeds ${MAX_RECORD_BYTES} bytes`)
  }
  return { kind: 'r', type, id, line }
}

/** A removal row for a key. */
export function removalRow(id: string, type: string): LineRow {
  const keyError = checkKey(type, id)
  if (keyError) {
    throw new InputRuleError(checkRecordId(id) === keyError ? 'bad_id' : 'bad_type', keyError)
  }
  return { kind: 'x', type, id, line: removalLine(id, type) }
}

/** The end (exclusive) of the JSON string starting at `from`, which must be a quote. */
function stringEnd(s: string, from: number): number {
  if (s.charCodeAt(from) !== 0x22) throw new FormatError('Not a canonical line')
  for (let i = from + 1; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x5c) i++
    else if (c === 0x22) return i + 1
  }
  throw new FormatError('Not a canonical line')
}

/**
 * The kind and key of a canonical line, read from its fixed envelope without
 * parsing its data. The line must have come from `parseInputLine` or a verified
 * file.
 */
export function lineKey(line: string): Key & { kind: 'r' | 'x' } {
  if (!line.startsWith('{"id":')) throw new FormatError('Not a canonical line')
  const idEnd = stringEnd(line, 6)
  const id = JSON.parse(line.slice(6, idEnd)) as string
  if (line.startsWith(',"type":', idEnd)) {
    const typeEnd = stringEnd(line, idEnd + 8)
    return { kind: 'r', id, type: JSON.parse(line.slice(idEnd + 8, typeEnd)) as string }
  }
  if (line.startsWith(',"removed":true,"type":', idEnd)) {
    const typeEnd = stringEnd(line, idEnd + 23)
    if (typeEnd !== line.length - 1) throw new FormatError('Not a canonical line')
    return { kind: 'x', id, type: JSON.parse(line.slice(idEnd + 23, typeEnd)) as string }
  }
  throw new FormatError('Not a canonical line')
}

/** The start of a record line up to its data: what fixes its id and type. */
export function recordPrefix(id: string, type: string): string {
  return '{"id":' + JSON.stringify(id) + ',"type":' + JSON.stringify(type) + ',"data":'
}
