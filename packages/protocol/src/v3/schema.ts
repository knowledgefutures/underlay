/**
 * Checking an upload before it is committed (docs/protocol-v3.md, Sections 4.3
 * to 4.5): its files came with it, are well formed, every record is canonical and satisfies
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
import { type BumpType, parseSemver } from '../semver.js'
import { checkSchemaFull, compileSchema, type SchemaValidator } from '../validate.js'
import { installUpload, recordKey, uploadKey } from './build.js'
import { ASSET_TYPE, META_TYPE, SCHEMA_TYPE } from './constants.js'
import type { FileRef } from './file.js'
import { compareKeys, type Entry } from './lines.js'
import {
  type CommitInput,
  type CommitOptions,
  createCommit,
  makeChange,
  type StoredCommit,
} from './log.js'
import { type FileCache, getRecord, mergeGroups, openFile, openView, type View } from './read.js'
import { EntryCursor, type FileReader, SortedFile } from './reader.js'
import { inParallel } from './util.js'
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
  /**
   * With `validate`, whether to check the upload's own rows too (default true). False
   * for a builder that already checked each row against the schemas the upload sets,
   * such as a server building a push it validated as it arrived: the records already in
   * the collection are still scanned when a schema changes.
   */
  validateRows?: boolean
  /** Require every `$asset` row's asset to be stored. Default true. */
  checkAssets?: boolean
  /** Problems to collect before giving up. */
  maxProblems?: number
  /**
   * With `validate`, whether to scan the records already there when a schema changes in a
   * way that could reject one (default true). False when the caller has scanned them
   * itself, in parts (`scanUnderSchema`), against the same head.
   */
  scan?: boolean
  /**
   * Where the upload's files are: by default among the stored files; for an
   * upload being checked, its session (`uploads/<session>/<id>`).
   */
  locate?: (id: string) => string
}

/** Open one of an upload's files where it is: the shared cache is for stored files only. */
type OpenUploaded = (id: string) => Promise<SortedFile>
function opener(store: Store, opts: CheckOptions): OpenUploaded {
  const locate = opts.locate
  if (!locate) return (id) => (opts.cache ? opts.cache.open(store, id) : openFile(store, id))
  const opened = new Map<string, Promise<SortedFile>>()
  return (id) => {
    let p = opened.get(id)
    if (!p) opened.set(id, (p = SortedFile.open(store, locate(id), { id })))
    return p
  }
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
  open: OpenUploaded,
  files: FileRef[],
  type: string,
  from = '',
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
    const file = await open(f.id)
    const reader = file.reader({ readAhead: 1024 * 1024 })
    const cursor = new EntryCursor(reader, 1)
    await cursor.seek({ type, id: from })
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
  // The schemas sit next to each other, so their lookups share readers and fetch a block once.
  const schemaRead = { ...read, readers: new Map<string, FileReader>() }
  const validate = opts.validate ?? true
  const validateRows = validate && (opts.validateRows ?? true)
  const open = opener(store, opts)

  // The schemas the upload sets, and the ones in force before it.
  const current = new Map<string, { hash: string; body: unknown } | null>()
  const currentSchema = async (type: string) => {
    let c = current.get(type)
    if (c === undefined) {
      const r = await getRecord(store, view, SCHEMA_TYPE, type, schemaRead)
      c = r && r.line ? { hash: r.hash, body: dataOf(r.line) } : null
      current.set(type, c)
    }
    return c
  }
  const set = new Map<string, unknown | null>()
  const changed: string[] = []
  for await (const { entry, line } of uploadEntries(open, files, SCHEMA_TYPE)) {
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
    for (const type of await typesOf(open, files)) {
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
      const v = await verifyFile(store, opts.locate?.(f.id) ?? recordKey(f.id), {
        id: f.id,
        labeled: false,
        canonical: true,
        ...(validateRows ? { onRecord } : {}),
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
    } else {
      // Files taken as well formed (a trusted builder). One thing is still checked, since
      // version ids rest on it: a commit names only files as their author built them, with
      // no commit numbers inside (Section 4). The footer says which, and it is read anyway.
      const file = await open(f.id)
      if (file.content.labeled) {
        fail(`File ${f.id} is labeled: a commit names only files with no commit numbers in them`)
      } else if (validateRows && f.first) {
        // The records are still validated.
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
  }

  // A schema change that could reject records already there: scan the ones the upload leaves.
  let scanned = 0
  for (const type of validate && (opts.scan ?? true) ? changed : []) {
    const before = await currentSchema(type)
    const after = set.get(type)
    if (!before) continue
    if (after !== null && after !== undefined && schemaRelaxes(before.body, after)) continue
    const r = await scanWith(store, view, open, files, type, after ?? null, {}, read, fail)
    scanned += r
  }

  if (opts.checkAssets ?? true) {
    for await (const { entry } of uploadEntries(open, files, ASSET_TYPE)) {
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

/**
 * Check the records of one type that a version carries over into an upload against the
 * type's new schema (null: the upload removes the schema, so none may remain). Records the
 * upload replaces or removes are skipped: they were checked as the upload's own. With
 * `range`, only that stretch of the type's keys: one unit of a scan split across
 * processes. Returns the records scanned and the problems found, at most `maxProblems`.
 */
export async function scanUnderSchema(
  store: Store,
  view: View,
  upload: { files: FileRef[]; locate: (id: string) => string },
  type: string,
  schema: unknown | null,
  range: { from?: string; to?: string } = {},
  opts: { cache?: FileCache; maxProblems?: number } = {},
): Promise<{ scanned: number; problems: string[] }> {
  const problems: string[] = []
  const max = opts.maxProblems ?? 20
  const open = opener(store, { locate: upload.locate })
  const fail = (what: string) => {
    if (problems.length < max) problems.push(what)
  }
  const read = opts.cache ? { cache: opts.cache } : {}
  const scanned = await scanWith(store, view, open, upload.files, type, schema, range, read, fail)
  return { scanned, problems }
}

async function scanWith(
  store: Store,
  view: View,
  open: OpenUploaded,
  files: FileRef[],
  type: string,
  after: unknown | null,
  range: { from?: string; to?: string },
  read: { cache?: FileCache },
  fail: (what: string) => void,
): Promise<number> {
  let scanned = 0
  const v = after === null ? null : compileSchema(after)
  const replaced = uploadEntries(open, files, type, range.from ?? '')
  let next = await replaced.next()
  const keys = {
    type,
    ...(range.from !== undefined ? { from: { type, id: range.from } } : {}),
    ...(range.to !== undefined ? { to: { type, id: range.to } } : {}),
  }
  for await (const group of mergeGroups(store, view, keys, { ...read, readAhead: 1 << 20 })) {
    const winner = group[group.length - 1]!
    const e = winner.entry
    if (e.type !== type) break
    if (e.kind === 'x') continue
    while (
      !next.done &&
      compareKeys(next.value.entry.type, next.value.entry.id, e.type, e.id) < 0
    ) {
      next = await replaced.next()
    }
    // The upload replaces or removes this record: it was checked as the upload's own, or is gone.
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
  return scanned
}

/** The types that have rows in an upload, from its key entries: a seek for each type. */
async function typesOf(open: OpenUploaded, files: FileRef[]): Promise<string[]> {
  const out = new Set<string>()
  for (const f of files) {
    if (!f.first) continue
    const file = await open(f.id)
    const cursor = new EntryCursor(file.reader({ readAhead: 1024 * 1024 }), 1)
    await cursor.seek()
    while (cursor.current) {
      const type = cursor.current.type
      // Its first row may be a removal with records after it, so every type counts.
      out.add(type)
      // Skip to the next type: past every id of this one.
      await cursor.seek({ type: type + '\u0000', id: '' })
    }
  }
  return [...out]
}

export interface UploadOptions extends CheckOptions, CommitOptions {
  /**
   * The upload session the files' bytes came in. A commit may name a file only
   * if its bytes are there: never because a file with that id is already stored.
   * Otherwise knowing an id would be a way to test for a file, and to read it.
   */
  session: string
}

/**
 * Check an upload and commit it: the server's entry for a change from outside.
 * Every file the change names must be in the upload's session. Once checked,
 * the files are installed among the stored files, the commit is created, and
 * the session's copies are deleted. If another commit lands first, the upload
 * is checked again against the new head, since the schemas it must satisfy may
 * have changed.
 *
 * (`createCommit` is the step beneath this, for the server's own use: a fork's
 * copy, or files the server itself has just verified.)
 */
export async function commitUpload(
  store: Store,
  collection: string,
  input: Omit<CommitInput, 'bump'>,
  opts: UploadOptions,
): Promise<StoredCommit & { check: UploadCheck }> {
  const change =
    input.change ??
    (await makeChange(collection, {
      files: input.files ?? [],
      base: input.base ?? null,
      message: input.message ?? null,
    }))
  const files = change.files
  const locate = (id: string) => uploadKey(opts.session, id)
  // A first load names hundreds of files: check, install, and clear them a few at a time.
  const each = (fn: (f: FileRef) => Promise<void>) =>
    inParallel(
      files.map((f) => () => fn(f)),
      16,
    )
  await each(async (f) => {
    if (!(await store.head(locate(f.id)))) {
      throw new UploadError([`File ${f.id} did not come with this upload`])
    }
  })
  let check: UploadCheck | undefined
  /** The major version of the head the check was made against (null: no commits yet). */
  let checkedMajor: number | null | undefined
  let installed = false
  const made = await createCommit(
    store,
    collection,
    {
      change,
      ...(input.baseNumber === undefined ? {} : { baseNumber: input.baseNumber }),
      bump: async (head) => {
        // Asked again when another commit took the number. The check stands if no schema has
        // changed since (a schema change is a major version, 4.4) and this upload changes
        // none: nothing else in it depends on the head. So a lost race costs no second pass
        // over the upload.
        const major = head ? parseSemver(head.commit.semver).major : null
        if (!check || check.schemasChanged.length > 0 || major !== checkedMajor) {
          const view = await openView(store, collection, { version: head?.commit.number ?? 0 })
          check = await checkUpload(store, view, files, { ...opts, locate })
          checkedMajor = major
        }
        if (!installed) {
          await each((f) => installUpload(store, opts.session, f.id))
          installed = true
        }
        return check.bump
      },
    },
    opts,
  )
  await each((f) => store.delete(locate(f.id)))
  return { ...made, check: check! }
}
