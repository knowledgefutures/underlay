/**
 * Rewriting a collection's history into the protocol's one spelling (docs/protocol.md,
 * Appendix D). Two forms written by v3 drafts are not part of the protocol, and both sit in
 * hashed bytes:
 *
 *   - `ulv3:<hex>` in a commit's `previous` and its changes' `base` (bare hex now);
 *   - `{"$file": "sha256:<hex>", …}` in record data (`{"$asset": "ul:asset:<hex>", …}` now).
 *
 * Changing either changes a commit's bytes, so its version id, and so every later commit's
 * `previous`. The rewrite makes the whole log again, in order:
 *
 *   1. read every row of the collection (from the current layout's files and the files of
 *      the commits after it), by the commit that wrote it, only where some record holds a
 *      `$file` reference; otherwise no file changes and only commits are rewritten;
 *   2. for each commit: convert its rows' references, and where any changed, write its files
 *      again, cut where its files began; name the new files, map `previous` and `base` to
 *      the rewritten ids, and sign again with the server's key if the commit was signed;
 *   3. store a plan (`collections/<id>/rewrite.json`: each commit's id before and after)
 *      before writing anything, so a rewrite that stops part way is finished by running it
 *      again, and old ids stay resolvable;
 *   4. write the new files, then a new layout listing every commit's own files (only when
 *      files changed), then the commits in order, their receipts, and the description's
 *      `forkedFrom`.
 *
 * Converting a reference is idempotent, so running the rewrite again over a collection it has
 * finished, or over a layout a rebuild wrote from old files meanwhile, converges. A server
 * runs it where commits land for the collection, so no commit lands during it.
 */
import { jcs } from '../jcs.js'
import type { Signer } from '../repo/log.js'
import type { Store } from '../repo/types.js'
import { sha256Hex } from '../sha256.js'
import { utf8 } from '../utf8.js'
import { compileSchema, type SchemaValidator } from '../validate.js'
import { receiptKey, parseReceipt, type Receipt } from './author.js'
import { recordKey } from './build.js'
import { readDescription } from './collection.js'
import { SCHEMA_TYPE } from './constants.js'
import { fileRef, type FileRef, writeFileBytes, type WriteRow } from './file.js'
import { compareKeys, type Entry } from './lines.js'
import {
  collectionPrefix,
  type Commit,
  commitKey,
  createLayout,
  descriptionKey,
  findLayout,
  headNumber,
  type Layout,
  type LayoutFile,
  writeLayoutHint,
} from './log.js'
import { openFile } from './read.js'
import { signObject } from './sign.js'

const HEX = /^[0-9a-f]{64}$/
const LEGACY_ID = /^ulv3:([0-9a-f]{64})$/
const FILE_REF = /^sha256:([0-9a-f]{64})$/
const dec = new TextDecoder()

export const rewriteKey = (collection: string) => `${collectionPrefix(collection)}rewrite.json`

/** What a rewrite did, or would do: each commit's version id before and after, as hex. */
export interface RewritePlan {
  collection: string
  /** Commits whose bytes change, and the old and new hex of every commit, in order. */
  commits: { number: number; before: string; after: string }[]
  /** Records whose data had `$file` references, over all commits. */
  records: number
  /** Schemas whose `$file` properties became `$asset`: each type's schema hash before and after. */
  schemas: { type: string; before: string; after: string }[]
  /** Files written again because a row in them changed. */
  files: number
  /** The layout written, when files changed. */
  layout: number | null
  createdAt: string
}

export interface RewriteOptions {
  /** Signs commits that were signed, and receipts. Needed if any is. */
  signer?: Signer
  /** Work everything out and write nothing. */
  dryRun?: boolean
  now?: () => Date
  /** Most bytes of lines read when records must be scanned; past it the rewrite refuses. */
  maxScanBytes?: number
}

export class RewriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RewriteError'
  }
}

/** A hex version id from a commit's `previous` or `base` in either spelling, or null. */
function hexOf(v: unknown, what: string): string | null {
  if (v === null) return null
  if (typeof v === 'string') {
    if (HEX.test(v)) return v
    const m = LEGACY_ID.exec(v)
    if (m) return m[1]!
  }
  throw new RewriteError(`${what} is not a version id: ${JSON.stringify(v)}`)
}

/**
 * Convert the `$file` references in record data to asset references, as a new value; the
 * value itself when there are none. A reference is an object whose `$file` is
 * `sha256:<hex>`; it keeps its other members, and is not searched further.
 */
export function convertFileRefs(data: unknown): { data: unknown; count: number } {
  let count = 0
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((x) => {
        const y = walk(x)
        if (y !== x) changed = true
        return y
      })
      return changed ? out : v
    }
    const o = v as Record<string, unknown>
    if (Object.hasOwn(o, '$file') && typeof o.$file === 'string') {
      const m = FILE_REF.exec(o.$file)
      if (m) {
        if (Object.hasOwn(o, '$asset')) {
          throw new RewriteError('An object has both $file and $asset')
        }
        count++
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(o)) {
          if (k === '$file') out.$asset = `ul:asset:${m[1]}`
          else out[k] = o[k]
        }
        return out
      }
    }
    if (Object.hasOwn(o, '$asset') || Object.hasOwn(o, '$link')) return v
    let changed = false
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o)) {
      const y = walk(o[k])
      if (y !== o[k]) changed = true
      out[k] = y
    }
    return changed ? out : v
  }
  const data2 = walk(data)
  return { data: data2, count }
}

/**
 * Convert a schema written for `$file` references to one for asset references: a `$file`
 * property becomes `$asset` (a `^sha256:` pattern on it becomes `^ul:asset:`), and `$file` in
 * `required` becomes `$asset`. The value itself when there is nothing to convert.
 */
export function convertSchemaRefs(schema: unknown): { schema: unknown; count: number } {
  let count = 0
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((x) => {
        const y = walk(x)
        if (y !== x) changed = true
        return y
      })
      return changed ? out : v
    }
    const o = v as Record<string, unknown>
    let changed = false
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o)) {
      let y = walk(o[k])
      if (k === 'properties' && y && typeof y === 'object' && Object.hasOwn(y, '$file')) {
        const props = y as Record<string, unknown>
        if (Object.hasOwn(props, '$asset')) {
          throw new RewriteError('A schema has properties for both $file and $asset')
        }
        const next: Record<string, unknown> = {}
        for (const pk of Object.keys(props)) {
          if (pk !== '$file') {
            next[pk] = props[pk]
            continue
          }
          let prop = props[pk]
          if (prop && typeof prop === 'object' && !Array.isArray(prop)) {
            const pattern = (prop as Record<string, unknown>).pattern
            if (typeof pattern === 'string' && pattern.startsWith('^sha256:')) {
              prop = { ...prop, pattern: '^ul:asset:' + pattern.slice('^sha256:'.length) }
            }
          }
          next.$asset = prop
        }
        y = next
        count++
      }
      if (k === 'required' && Array.isArray(y) && y.includes('$file')) {
        y = y.map((r) => (r === '$file' ? '$asset' : r))
        count++
      }
      if (y !== o[k]) changed = true
      out[k] = y
    }
    return changed ? out : v
  }
  const schema2 = walk(schema)
  return { schema: schema2, count }
}

/**
 * Whether renaming a member `$file` to `$asset`, keeping its value, could change what a
 * schema says of a record that satisfied it. Only keywords that look at member names can
 * tell the two apart: names in `properties`, `required`, or `dependencies` (the schema's text
 * then holds `"$file"` or `"$asset"`), `patternProperties`, `propertyNames`, and an
 * `additionalProperties` other than `true`. A `const` or `enum` could only match an object
 * holding `$file` if its text held `"$file"`. When none is there the record is not checked
 * again: validating is costly for some documents (one of 567 KB against a 24 KB schema took
 * 211 s in Node), far past what a Durable Object may spend.
 */
export function renameMatters(schema: unknown): boolean {
  const text = JSON.stringify(schema)
  if (text.includes('"$file"') || text.includes('"$asset"')) return true
  const walk = (v: unknown): boolean => {
    if (v === null || typeof v !== 'object') return false
    if (Array.isArray(v)) return v.some(walk)
    const o = v as Record<string, unknown>
    if (Object.hasOwn(o, 'patternProperties') || Object.hasOwn(o, 'propertyNames')) return true
    if (Object.hasOwn(o, 'additionalProperties') && o.additionalProperties !== true) return true
    return Object.values(o).some(walk)
  }
  return walk(schema)
}

/** A `$schema` line with its `$file` properties converted, or null when it has none. */
function convertSchemaLine(line: string): string | null {
  if (!line.includes('"$file"')) return null
  const o = JSON.parse(line) as { id: string; type: string; data: unknown }
  const { schema, count } = convertSchemaRefs(o.data)
  if (count === 0) return null
  return (
    '{"id":' +
    JSON.stringify(o.id) +
    ',"type":' +
    JSON.stringify(o.type) +
    ',"data":' +
    jcs(schema) +
    '}'
  )
}

/** A record line with its references converted, or null when it holds none. */
function convertLine(line: string): string | null {
  if (!line.includes('"$file"')) return null
  const o = JSON.parse(line) as { id: string; type: string; data: unknown }
  const { data, count } = convertFileRefs(o.data)
  if (count === 0) return null
  return (
    '{"id":' +
    JSON.stringify(o.id) +
    ',"type":' +
    JSON.stringify(o.type) +
    ',"data":' +
    jcs(data) +
    '}'
  )
}

interface Row {
  kind: 'r' | 'x' | 'w'
  type: string
  id: string
  line: string | null
  hash: string | null
  size: number
}

interface OldCommit {
  number: number
  /** As stored. */
  raw: Record<string, unknown>
  bytes: Uint8Array
  hex: string
}

async function readRaw(store: Store, collection: string, n: number): Promise<OldCommit> {
  const obj = await store.get(commitKey(collection, n))
  if (!obj) throw new RewriteError(`Commit ${n} of ${collection} is missing`)
  const bytes = await obj.bytes()
  const raw = JSON.parse(dec.decode(bytes)) as Record<string, unknown>
  if (raw.number !== n)
    throw new RewriteError(`Commit ${n} of ${collection} carries another number`)
  return { number: n, raw, bytes, hex: sha256Hex(bytes) }
}

const filesOfRaw = (raw: Record<string, unknown>): FileRef[] =>
  (raw.changes as { files: FileRef[] }[]).flatMap((c) => c.files)

/**
 * Whether a collection's rows must be read: some file holds a `$asset` row (only then can a
 * record hold a reference), or a `$schema` row that names `$file`. Reserved rows sort first
 * (`$asset` < `$meta` < `$schema` < any publisher type), so a file is opened only if its first
 * key, as its layout or commit records it, is one of them; and then only its first key blocks
 * are read, however large it is. A collection of thousands of files of records opens none.
 */
async function mustScan(
  store: Store,
  files: { id: string; first: [string, string] | null }[],
): Promise<boolean> {
  const pastSchemas = (k: [string, string] | null) =>
    k !== null && compareKeys(k[0], k[1], SCHEMA_TYPE, '\u{10FFFF}') > 0
  for (const { id, first } of files) {
    if (!first || pastSchemas(first)) continue
    const f = await openFile(store, id)
    if (!f.content.first || pastSchemas(f.content.first)) continue
    const reader = f.reader()
    const blocks = f.content.keyBlocks
    for (let b = 0; b < blocks.length; b++) {
      if (pastSchemas([blocks[b]![0], blocks[b]![1]])) break
      for (const e of await reader.keyBlock(b)) {
        if (e.type === '$asset') return true
        if (e.type !== SCHEMA_TYPE) continue
        if (e.kind === 'r' && dec.decode(await reader.line(e)).includes('"$file"')) return true
      }
    }
  }
  return false
}

/** Every row of a set of files, by the commit that wrote it. */
async function rowsByCommit(
  store: Store,
  files: { id: string; commit: number | null }[],
  maxBytes: number,
): Promise<Map<number, Row[]>> {
  const out = new Map<number, Row[]>()
  let bytes = 0
  for (const { id, commit } of files) {
    const f = await openFile(store, id)
    bytes += f.content.bytes
    if (bytes > maxBytes) {
      throw new RewriteError(`More than ${maxBytes} bytes of lines to scan; rewrite it in parts`)
    }
    const reader = f.reader()
    for (let b = 0; b < f.content.keyBlocks.length; b++) {
      const entries: Entry[] = await reader.keyBlock(b)
      for (const e of entries) {
        const c = commit ?? e.commit
        if (c === undefined) throw new RewriteError(`File ${id} has an entry with no commit`)
        const line = e.kind === 'w' ? null : dec.decode(await reader.line(e))
        const list = out.get(c) ?? []
        list.push({ kind: e.kind, type: e.type, id: e.id, line, hash: e.hash, size: e.size })
        out.set(c, list)
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => compareKeys(a.type, a.id, b.type, b.id))
  return out
}

/** A commit's rows cut where its files began, written as unlabeled files (in memory). */
async function writeCommitFiles(
  rows: Row[],
  wants: FileRef[],
): Promise<{ ref: FileRef; bytes: Uint8Array; size: number }[]> {
  const ranged = wants
    .filter((f) => f.first)
    .sort((a, b) => compareKeys(a.first![0], a.first![1], b.first![0], b.first![1]))
  const out: { ref: FileRef; bytes: Uint8Array; size: number }[] = []
  for (const f of wants) {
    if (f.first) continue
    const empty = await writeFileBytes([])
    out.push({ ref: fileRef(empty.id, empty.content), bytes: empty.bytes, size: empty.size })
  }
  let i = 0
  for (let part = 0; part < ranged.length; part++) {
    const next = ranged[part + 1]?.first
    const mine: WriteRow[] = []
    while (i < rows.length) {
      const r = rows[i]!
      if (next && compareKeys(r.type, r.id, next[0], next[1]) >= 0) break
      if (r.kind === 'w' || r.line === null) {
        throw new RewriteError(
          `Row ${r.type} ${r.id} is withheld; its commit cannot be written again`,
        )
      }
      mine.push({ kind: r.kind, type: r.type, id: r.id, line: r.line })
      i++
    }
    const f = await writeFileBytes(mine)
    out.push({ ref: fileRef(f.id, f.content), bytes: f.bytes, size: f.size })
  }
  if (i !== rows.length) throw new RewriteError('Rows fall after the last file of their commit')
  return out
}

/** Rewrite one collection (see the file comment). Returns what changed. */
export async function rewriteCollection(
  store: Store,
  collection: string,
  opts: RewriteOptions = {},
): Promise<RewritePlan> {
  const now = opts.now ?? (() => new Date())
  const head = await headNumber(store, collection)
  const previousPlan = await readPlan(store, collection)
  // An id a commit may name as `previous` or `base`, from before a rewrite that stopped part
  // way, or from a fork's parent rewritten before it: its id now.
  const renamed = new Map<string, string>()
  const original = new Map<string, string>()
  for (const c of previousPlan?.commits ?? []) {
    renamed.set(c.before, c.after)
    original.set(c.after, c.before)
  }

  const old: OldCommit[] = []
  for (let n = 1; n <= head; n++) old.push(await readRaw(store, collection, n))

  // Rows, only if some record can hold a reference.
  const layout = await findLayout(store, collection)
  const through = layout?.through ?? 0
  const sources: { id: string; commit: number | null; first: [string, string] | null }[] = [
    ...(layout?.files ?? []).map((f) => ({
      id: f.id,
      commit: f.labeled ? null : f.commits[0],
      first: f.first,
    })),
    ...old
      .filter((c) => c.number > through)
      .flatMap((c) =>
        filesOfRaw(c.raw).map((f) => ({ id: f.id, commit: c.number, first: f.first })),
      ),
  ]
  const scan = await mustScan(store, sources)
  const rows = scan
    ? await rowsByCommit(store, sources, opts.maxScanBytes ?? 4 * 1024 * 1024 * 1024)
    : new Map<number, Row[]>()

  // Schemas as of each commit, to check every record whose data changes.
  // Each type's schema, compiled only if the rename could change its verdict (renameMatters).
  const schemas = new Map<string, SchemaValidator | 'unaffected' | null>()
  let records = 0
  const schemaPairs: RewritePlan['schemas'] = []
  const writes: { key: string; bytes: Uint8Array }[] = []
  let filesWritten = 0
  // A changed commit at or below the layout's `through`: its rows in the layout's files are
  // old, so a new layout lists every commit's own files instead.
  let needLayout = false
  const commitFiles = new Map<number, LayoutFile[]>()
  const result: RewritePlan['commits'] = []
  let prevAfter: string | null = null
  const newCommits: { number: number; bytes: Uint8Array; hex: string }[] = []

  for (const c of old) {
    const raw = c.raw
    // Its id before any rewrite: from the plan if an earlier run already rewrote it.
    const beforeHex = original.get(c.hex) ?? c.hex

    let files = filesOfRaw(raw)
    const mine = rows.get(c.number) ?? []
    let changed = 0
    const converted: Row[] = []
    let schemaRows = 0
    for (const r of mine) {
      if (r.type === SCHEMA_TYPE && r.kind === 'x') schemas.set(r.id, null)
      if (r.type === SCHEMA_TYPE && r.kind === 'r' && r.line) {
        const line = convertSchemaLine(r.line)
        const body = (JSON.parse(line ?? r.line) as { data: unknown }).data
        schemas.set(r.id, renameMatters(body) ? compileSchema(body) : 'unaffected')
        if (line !== null) {
          changed++
          schemaRows++
          const before = sha256Hex(jcs((JSON.parse(r.line) as { data: unknown }).data))
          const after = sha256Hex(jcs(body))
          if (!schemaPairs.some((p) => p.type === r.id && p.before === before))
            schemaPairs.push({ type: r.id, before, after })
          converted.push({ ...r, line, hash: null, size: utf8(line).byteLength })
          continue
        }
      }
      if (r.kind !== 'r' || r.line === null || r.type.startsWith('$')) {
        converted.push(r)
        continue
      }
      const line = convertLine(r.line)
      if (line === null) {
        converted.push(r)
        continue
      }
      changed++
      const v = schemas.get(r.type)
      if (!v) throw new RewriteError(`Commit ${c.number}: ${r.type} has no schema`)
      const errors = v === 'unaffected' ? [] : v((JSON.parse(line) as { data: unknown }).data)
      if (errors.length > 0) {
        throw new RewriteError(
          `Commit ${c.number}: ${r.type} ${JSON.stringify(r.id)} fails its schema once converted: ${errors[0]}`,
        )
      }
      converted.push({ ...r, line, hash: null, size: utf8(line).byteLength })
    }
    records += changed - schemaRows

    // Files: written again where a row changed, or where a layout will list them.
    const needFiles = scan && (changed > 0 || c.number <= through)
    if (needFiles) {
      const total = files.reduce((n, f) => n + f.entries, 0)
      if (mine.length !== total) {
        throw new RewriteError(
          `Commit ${c.number}: ${mine.length} rows found for ${total} entries (thinned history)`,
        )
      }
      const written = await writeCommitFiles(converted, files)
      const byFirst = (f: FileRef) => (f.first ? `${f.first[0]}\u0000${f.first[1]}` : '')
      const order = new Map(files.map((f, i) => [byFirst(f), i]))
      written.sort((a, b) => (order.get(byFirst(a.ref)) ?? 0) - (order.get(byFirst(b.ref)) ?? 0))
      if (changed === 0) {
        // Its own files, made again from the layout's rows, must be the files it named.
        const ids = written.map((w) => w.ref.id).sort()
        const want = files.map((f) => f.id).sort()
        if (ids.join() !== want.join()) {
          throw new RewriteError(`Commit ${c.number}: its files could not be made again`)
        }
      } else {
        files = written.map((w) => w.ref)
        filesWritten += written.length
        if (c.number <= through) needLayout = true
      }
      for (const w of written) writes.push({ key: recordKey(w.ref.id), bytes: w.bytes })
      commitFiles.set(
        c.number,
        written.map((w) => ({
          ...w.ref,
          labeled: false,
          commits: [c.number, c.number] as [number, number],
          group: 0,
          size: w.size,
        })),
      )
    }

    const mapId = (v: unknown, what: string) => {
      const hex = hexOf(v, what)
      return hex === null ? null : (renamed.get(hex) ?? hex)
    }
    const changes = (raw.changes as Record<string, unknown>[]).map((ch, i) => {
      const base = mapId(ch.base, `Commit ${c.number} change ${i} base`)
      const out = { ...ch, base, files: i === 0 ? files : (ch.files as FileRef[]) }
      if (ch.sig !== null && (base !== ch.base || out.files !== ch.files)) {
        throw new RewriteError(`Commit ${c.number}: an author's signed change would change`)
      }
      return out
    })
    if (changes.length !== 1 && changed > 0) {
      throw new RewriteError(`Commit ${c.number} has ${changes.length} changes`)
    }
    let commit = {
      ...(raw as unknown as Commit),
      previous: c.number === 1 ? null : prevAfter,
      changes: changes as unknown as Commit['changes'],
    }
    const same = jcs(commit) === dec.decode(c.bytes)
    if (!same && commit.keyId !== null) {
      if (!opts.signer) throw new RewriteError(`Commit ${c.number} is signed; a signer is needed`)
      commit = await signObject({ ...commit, keyId: null, sig: null }, opts.signer)
    }
    const bytes = same ? c.bytes : utf8(jcs(commit))
    const hex = sha256Hex(bytes)
    if (hex !== c.hex) renamed.set(c.hex, hex)
    result.push({ number: c.number, before: beforeHex, after: hex })
    if (!same) newCommits.push({ number: c.number, bytes, hex })
    prevAfter = hex
  }

  const plan: RewritePlan = {
    collection,
    commits: result,
    records,
    schemas: schemaPairs,
    files: filesWritten,
    layout: needLayout && layout ? layout.number + 1 : null,
    createdAt: now().toISOString(),
  }
  if (needLayout && layout?.retained) {
    throw new RewriteError('The layout keeps only some versions; they cannot all be written again')
  }
  if (opts.dryRun || (newCommits.length === 0 && filesWritten === 0)) return plan

  // The plan first: a rewrite that stops after this is finished by running it again.
  await store.put(rewriteKey(collection), jcs(plan), { contentType: 'application/json' })

  for (const w of writes) await store.put(w.key, w.bytes, { ifAbsent: true })

  if (needLayout && layout) {
    const files: LayoutFile[] = []
    for (let n = 1; n <= through; n++) files.push(...(commitFiles.get(n) ?? []))
    const next: Layout = {
      underlay: 3,
      collection,
      number: layout.number + 1,
      through,
      createdAt: now().toISOString(),
      files,
    }
    if (!(await createLayout(store, next))) {
      throw new RewriteError('A rebuild wrote a layout meanwhile; run the rewrite again')
    }
    await writeLayoutHint(store, collection, next.number)
  }

  for (const c of newCommits) {
    await store.put(commitKey(collection, c.number), c.bytes, { contentType: 'application/json' })
    const receipt = await readReceiptRaw(store, collection, c.number)
    if (receipt) {
      let r: Receipt = { ...receipt, version: c.hex }
      if (receipt.keyId !== null) {
        if (!opts.signer)
          throw new RewriteError(`Receipt ${c.number} is signed; a signer is needed`)
        r = await signObject({ ...r, keyId: null, sig: null }, opts.signer)
      }
      await store.put(receiptKey(collection, c.number), jcs(r), { contentType: 'application/json' })
    }
  }

  const description = await readDescription(store, collection)
  const from = description?.forkedFrom
  if (description && from) {
    const hex = hexOf(from.id.startsWith('ul:ver:') ? from.id.slice(7) : from.id, 'forkedFrom')!
    const after = renamed.get(hex)
    if (after) {
      await store.put(
        descriptionKey(collection),
        jcs({ ...description, forkedFrom: { ...from, id: `ul:ver:${after}` } }),
        { contentType: 'application/json' },
      )
    }
  }
  return plan
}

/** The plan a rewrite stored, or null. */
export async function readPlan(store: Store, collection: string): Promise<RewritePlan | null> {
  const obj = await store.get(rewriteKey(collection))
  return obj ? (JSON.parse(await obj.text()) as RewritePlan) : null
}

async function readReceiptRaw(
  store: Store,
  collection: string,
  n: number,
): Promise<Receipt | null> {
  const obj = await store.get(receiptKey(collection, n))
  if (!obj) return null
  const raw = JSON.parse(await obj.text()) as Receipt & { version: string }
  const m = LEGACY_ID.exec(raw.version)
  return parseReceipt(jcs({ ...raw, version: m ? m[1]! : raw.version }))
}

/** Whether a collection still holds a form the rewrite removes, from commits alone. */
export function commitNeedsRewrite(bytes: Uint8Array): boolean {
  return dec.decode(bytes).includes('"ulv3:')
}
