/**
 * Checking an upload before it is committed (docs/protocol-v3.md, Sections 4.1
 * and 4.2): the files are well formed, every record is canonical and satisfies
 * its type's schema, and the semver follows from the kinds of rows.
 *
 * The cost is one streaming pass over the uploaded files, plus a lookup for
 * each schema the upload touches or uses. Nothing else about the collection is
 * read, with one exception: a schema change that is not a pure relaxation scans
 * that type's existing records, since any of them might now be invalid.
 */
import { MAX_JSON_DEPTH } from '../constants.js'
import { parseStrict } from '../input-rules.js'
import { jcs } from '../jcs.js'
import type { Store } from '../repo/types.js'
import { schemaRelaxes } from '../schema-relax.js'
import type { BumpType } from '../semver.js'
import { checkSchemaFull, compileSchema, type SchemaValidator } from '../validate.js'
import { recordKey } from './build.js'
import { ASSET_TYPE, META_TYPE, SCHEMA_TYPE } from './constants.js'
import type { FileRef } from './file.js'
import { compareKeys, type Entry } from './lines.js'
import { type CommitInput, type CommitOptions, createCommit, type StoredCommit } from './log.js'
import { type FileCache, getRecord, mergeGroups, openFile, openView, type View } from './read.js'
import { EntryCursor } from './reader.js'
import { verifyFile } from './verify.js'

export class UploadError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.length === 1 ? problems[0]! : `${problems[0]} (and ${problems.length - 1} more)`)
    this.name = 'UploadError'
  }
}

export interface CheckOptions {
  cache?: FileCache
  /** Check the files' structure and that every record is canonical. Default true. */
  verify?: boolean
  /** Validate records against their schemas. Default true. */
  validate?: boolean
  /** Require every `$asset` row's asset to be stored. Default true. */
  checkAssets?: boolean
  /** Problems to collect before giving up. */
  maxProblems?: number
}

export interface UploadCheck {
  bump: BumpType
  /** Types whose schema the upload adds, changes, or removes. */
  schemasChanged: string[]
  /** Records of the upload that were validated. */
  validated: number
  /** Existing records scanned because a schema changed in a way that could reject them. */
  scanned: number
}

const dec = new TextDecoder()
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** The data of a canonical record line. */
function dataOf(line: Uint8Array): unknown {
  return (parseStrict(dec.decode(line), MAX_JSON_DEPTH + 1) as { data: unknown }).data
}

/** The upload's entries of one type, in key order, across its files. */
async function* uploadEntries(
  store: Store,
  files: FileRef[],
  type: string,
  cache: FileCache | undefined,
): AsyncGenerator<{ entry: Entry; line: () => Promise<Uint8Array> }> {
  const holding = files
    .filter(
      (f) =>
        f.first !== null &&
        f.last !== null &&
        compareKeys(f.first[0], '', type, '') <= 0 &&
        compareKeys(type, '', f.last[0], '') <= 0,
    )
    .sort((a, b) => compareKeys(a.first![0], a.first![1], b.first![0], b.first![1]))
  for (const f of holding) {
    const file = cache ? await cache.open(store, f.id) : await openFile(store, f.id)
    const reader = file.reader({ readAhead: 1024 * 1024 })
    const cursor = new EntryCursor(reader, 1)
    await cursor.seek({ type, id: '' })
    while (cursor.current && cursor.current.type === type) {
      const entry = cursor.current
      yield { entry, line: () => reader.line(entry) }
      await cursor.next()
    }
  }
}

function checkAssetData(data: unknown): string | null {
  if (
    !isObject(data) ||
    !Number.isSafeInteger(data.size) ||
    (data.size as number) < 0 ||
    !(data.mediaType === null || typeof data.mediaType === 'string')
  ) {
    return 'data must be {"size": n, "mediaType": string or null}'
  }
  return null
}

/**
 * Check an upload against the version it would follow. Throws `UploadError`
 * with what is wrong, or returns the kind of change it is.
 */
export async function checkUpload(
  store: Store,
  view: View,
  files: FileRef[],
  opts: CheckOptions = {},
): Promise<UploadCheck> {
  const max = opts.maxProblems ?? 20
  const problems: string[] = []
  const fail = (what: string) => {
    problems.push(what)
    if (problems.length >= max) throw new UploadError(problems)
  }
  const read = opts.cache ? { cache: opts.cache } : {}
  const validate = opts.validate ?? true

  // The schemas the upload sets, and the ones in force before it.
  const current = new Map<string, { hash: string; body: unknown } | null>()
  const currentSchema = async (type: string) => {
    let c = current.get(type)
    if (c === undefined) {
      const r = await getRecord(store, view, SCHEMA_TYPE, type, read)
      c = r && r.line ? { hash: r.hash, body: dataOf(r.line) } : null
      current.set(type, c)
    }
    return c
  }
  const set = new Map<string, unknown | null>()
  const changed: string[] = []
  for await (const { entry, line } of uploadEntries(store, files, SCHEMA_TYPE, opts.cache)) {
    const before = await currentSchema(entry.id)
    if (entry.kind === 'x') {
      set.set(entry.id, null)
      if (before) changed.push(entry.id)
      continue
    }
    const body = dataOf(await line())
    const error = checkSchemaFull(entry.id, body)
    if (error) fail(error)
    set.set(entry.id, body)
    if (!before || before.hash !== entry.hash) changed.push(entry.id)
  }
  if (problems.length > 0) throw new UploadError(problems)

  // The schema each of the upload's types must satisfy: the upload's own, else the collection's.
  const validators = new Map<string, SchemaValidator | 'removed' | 'none'>()
  for (const [type, body] of set)
    validators.set(type, body === null ? 'removed' : compileSchema(body))
  if (validate) {
    for (const type of await typesOf(store, files, opts.cache)) {
      if (type.startsWith('$') || validators.has(type)) continue
      const schema = await currentSchema(type)
      validators.set(type, schema ? compileSchema(schema.body) : 'none')
    }
  }
  const reported = new Set<string>()
  let validated = 0
  const onRecord = (type: string, id: string, data: unknown) => {
    if (type === SCHEMA_TYPE) return
    if (type === META_TYPE) {
      if (!isObject(data)) fail('$meta data must be an object')
      return
    }
    if (type === ASSET_TYPE) {
      const error = checkAssetData(data)
      if (error) fail(`$asset ${id}: ${error}`)
      return
    }
    const v = validators.get(type)
    if (v === undefined || v === 'none' || v === 'removed') {
      if (!reported.has(type)) {
        reported.add(type)
        fail(
          v === 'removed'
            ? `Type "${type}" has records but its schema is removed`
            : `Type "${type}" has records but no schema`,
        )
      }
      return
    }
    validated++
    const errors = v(data)
    if (errors.length > 0) fail(`${type} ${JSON.stringify(id)}: ${errors[0]}`)
  }

  // One pass over the files: structure, canonical form, and each record against its schema.
  const types = new Set<string>()
  for (const f of files) {
    if (f.first && f.last) {
      types.add(f.first[0])
      types.add(f.last[0])
    }
    if (opts.verify ?? true) {
      const v = await verifyFile(store, recordKey(f.id), {
        id: f.id,
        labeled: false,
        canonical: true,
        ...(validate ? { onRecord } : {}),
      })
      const c = v.content
      if (
        c.entries !== f.entries ||
        c.records !== f.records ||
        c.removals !== f.removals ||
        c.bytes !== f.bytes ||
        jcs(c.first) !== jcs(f.first) ||
        jcs(c.last) !== jcs(f.last)
      ) {
        fail(`File ${f.id} is not as the upload describes it`)
      }
    } else if (validate && f.first) {
      // Files taken as well formed (a trusted builder): the records are still validated.
      const file = opts.cache ? await opts.cache.open(store, f.id) : await openFile(store, f.id)
      const reader = file.reader({ readAhead: 4 * 1024 * 1024 })
      const cursor = new EntryCursor(reader, 1)
      await cursor.seek()
      while (cursor.current) {
        const e = cursor.current
        if (e.kind === 'r') onRecord(e.type, e.id, dataOf(await reader.line(e)))
        await cursor.next()
      }
    }
  }

  // A schema change that could reject records already there: scan the ones the upload leaves.
  let scanned = 0
  for (const type of validate ? changed : []) {
    const before = await currentSchema(type)
    const after = set.get(type)
    if (!before) continue
    if (after !== null && after !== undefined && schemaRelaxes(before.body, after)) continue
    const v = after === null || after === undefined ? null : compileSchema(after)
    const replaced = uploadEntries(store, files, type, opts.cache)
    let next = await replaced.next()
    for await (const group of mergeGroups(store, view, { type }, { ...read, readAhead: 1 << 20 })) {
      const winner = group[group.length - 1]!
      const e = winner.entry
      if (e.kind === 'x') continue
      while (
        !next.done &&
        compareKeys(next.value.entry.type, next.value.entry.id, e.type, e.id) < 0
      ) {
        next = await replaced.next()
      }
      // The upload replaces or removes this record: it was checked above, or is gone.
      if (!next.done && next.value.entry.id === e.id) continue
      scanned++
      if (v === null) {
        fail(`Type "${type}" still has records but its schema is removed`)
        break
      }
      if (e.kind === 'w') continue
      const errors = v(dataOf(await winner.reader.line(e)))
      if (errors.length > 0) {
        fail(`${type} ${JSON.stringify(e.id)} does not satisfy the new schema: ${errors[0]}`)
      }
    }
    await replaced.return(undefined)
  }

  if (opts.checkAssets ?? true) {
    for await (const { entry } of uploadEntries(store, files, ASSET_TYPE, opts.cache)) {
      if (entry.kind !== 'r') continue
      if (!(await store.head(`assets/${entry.id}`))) fail(`Asset ${entry.id} is not stored`)
    }
  }
  if (problems.length > 0) throw new UploadError(problems)

  // Reserved types all begin with `$`, so a file holds a publisher's rows exactly when
  // its first or last key's type does not.
  const ordinary = [...types].some((t) => !t.startsWith('$'))
  return {
    bump: changed.length > 0 ? 'major' : ordinary ? 'minor' : 'patch',
    schemasChanged: changed,
    validated,
    scanned,
  }
}

/** The publisher's types that have records in an upload, from its key entries. */
async function typesOf(
  store: Store,
  files: FileRef[],
  cache: FileCache | undefined,
): Promise<string[]> {
  const out = new Set<string>()
  for (const f of files) {
    if (!f.first) continue
    const file = cache ? await cache.open(store, f.id) : await openFile(store, f.id)
    const cursor = new EntryCursor(file.reader({ readAhead: 1024 * 1024 }), 1)
    await cursor.seek()
    while (cursor.current) {
      const type = cursor.current.type
      if (cursor.current.kind === 'r') out.add(type)
      // Skip to the next type: past every id of this one.
      await cursor.seek({ type: type + '\u0000', id: '' })
    }
  }
  return [...out]
}

/**
 * Check an upload and commit it. If another commit lands first, the upload is
 * checked again against the new head, since the schemas it must satisfy may
 * have changed.
 */
export async function commitUpload(
  store: Store,
  collection: string,
  input: Omit<CommitInput, 'bump'>,
  opts: CheckOptions & CommitOptions = {},
): Promise<StoredCommit & { check: UploadCheck }> {
  let check: UploadCheck | undefined
  const made = await createCommit(
    store,
    collection,
    {
      ...input,
      bump: async (head) => {
        const view = await openView(store, collection, { version: head?.commit.number ?? 0 })
        check = await checkUpload(store, view, input.files, opts)
        return check.bump
      },
    },
    opts,
  )
  return { ...made, check: check! }
}
