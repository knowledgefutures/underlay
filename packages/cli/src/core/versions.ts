/**
 * Versions on this machine (local-tool.md "Versions and push"). A version is a real v3
 * commit, built here with the library and kept in the store's log for the collection, so
 * pushing copies it up unchanged and it has the same id here and on its authority.
 *
 * Until it is pushed a version can be changed: undo drops the newest, squash merges several
 * into one, reword changes a message. Each of these, and a pull that finds the authority
 * moved, builds the later commits again (a replay): their numbers and ids change, and their
 * change id, kept in the store's notes, does not.
 */
import { createObject, hashSchema, sha256Hex, type Store, v3 } from '@underlay/protocol'

import type { Coll } from './context.js'
import { CliError } from './env.js'
import { type CollectionState, emptyView, type LocalStore, type VersionNote } from './store.js'

type StoredCommit = v3.StoredCommit
const dec = new TextDecoder()

/** The first key after every reserved type: publisher types never begin with `$`. */
export const PAST_RESERVED: v3.Key = { type: '$\u{10FFFF}', id: '' }

export const cidOf = (c: Coll) => c.meta.id

/** A file as a commit names it. */
export const refOf = (f: v3.FileRef): v3.FileRef => ({
  id: f.id,
  first: f.first,
  last: f.last,
  entries: f.entries,
  records: f.records,
  removals: f.removals,
  bytes: f.bytes,
})

export async function headOf(c: Coll): Promise<StoredCommit | null> {
  return v3.findHead(c.store.fs, cidOf(c))
}

/** A version of the collection (the newest by default) as the library reads it. */
export async function viewOf(c: Coll, version?: number): Promise<v3.View> {
  const head = await v3.headNumber(c.store.fs, cidOf(c))
  if (head === 0) return emptyView(cidOf(c))
  return v3.openView(c.data, cidOf(c), version === undefined ? {} : { version })
}

/** Every commit here, oldest first. */
export async function logOf(c: Coll): Promise<StoredCommit[]> {
  const n = await v3.headNumber(c.store.fs, cidOf(c))
  const out: StoredCommit[] = []
  if (n > 0) for await (const s of v3.readLog(c.store.fs, cidOf(c), 1, n)) out.push(s)
  return out
}

/** The commits after the authority's newest: the versions not yet pushed. */
export async function unpushedOf(c: Coll): Promise<StoredCommit[]> {
  const from = (c.store.state(cidOf(c)).remote?.number ?? 0) + 1
  const n = await v3.headNumber(c.store.fs, cidOf(c))
  const out: StoredCommit[] = []
  if (n >= from) for await (const s of v3.readLog(c.store.fs, cidOf(c), from, n)) out.push(s)
  return out
}

/** The schemas of a version, by type. */
export async function schemasAt(store: Store, view: v3.View): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for await (const r of v3.exportAll(store, view, { type: v3.SCHEMA_TYPE }))
    if (r.line) out[r.id] = (JSON.parse(dec.decode(r.line)) as { data: unknown }).data
  return out
}

/** The kind of change files are against a version, as an authority finds it. */
export async function bumpAgainst(
  store: Store,
  view: v3.View,
  files: v3.FileRef[],
): Promise<'major' | 'minor' | 'patch'> {
  const check = await v3.checkUpload(store, view, files, {
    verify: false,
    validate: false,
    checkAssets: false,
  })
  return check.bump
}

export interface SaveInput {
  /** The rows a script wrote: records, and removals (`{id, type, removed: true}`). */
  rows: AsyncIterable<v3.LineRow> | Iterable<v3.LineRow>
  /**
   * `set`: the rows are the whole collection (or the part `scope` names), so what the head
   * holds and they lack is removed. `additions`: added and changed records only.
   */
  mode: 'set' | 'additions'
  /** With `set`: only these types are the script's, and only their records it lacks are removed. */
  types?: string[]
  /** With `set`: only records whose data has these values are the script's (`unit = CSAIL`). */
  where?: Record<string, unknown>
  /** The schemas in force after the version: home's `schemas/`. */
  schemas: Record<string, unknown>
  message: string | null
  run?: string
  now: Date
}

export interface SaveResult {
  version: StoredCommit | null
  stats: { added: number; changed: number; removed: number; schemas: number }
}

function inScope(input: SaveInput, type: string, line: Uint8Array | null): boolean {
  if (input.types && !input.types.includes(type)) return false
  if (!input.where) return true
  if (!line) return false
  const data = (JSON.parse(dec.decode(line)) as { data: Record<string, unknown> }).data
  return Object.entries(input.where).every(([k, v]) => data?.[k] === v)
}

/**
 * Save a version: the rows compared with the head, and what changed (with any schema changed
 * in home) written as files and committed here. Null when nothing changed.
 */
export async function saveVersion(c: Coll, input: SaveInput): Promise<SaveResult> {
  const cid = cidOf(c)
  const fs = c.store.fs
  const head = await headOf(c)
  const view = head ? await v3.openView(c.data, cid) : emptyView(cid)
  const stats = { added: 0, changed: 0, removed: 0, schemas: 0 }

  // --- Schema rows: home's schemas against the head's ---
  const headSchemas = await schemasAt(c.data, view)
  const schemaRows: v3.LineRow[] = []
  for (const [type, body] of Object.entries(input.schemas)) {
    if (headSchemas[type] !== undefined && hashSchema(headSchemas[type]) === hashSchema(body))
      continue
    schemaRows.push(v3.rowFromRecord(type, v3.SCHEMA_TYPE, body))
  }
  const dropped = Object.keys(headSchemas).filter((t) => !(t in input.schemas))
  for (const type of dropped) schemaRows.push(v3.removalRow(type, v3.SCHEMA_TYPE))
  schemaRows.sort(v3.compareKey)
  stats.schemas = schemaRows.length

  // --- Data rows: the output, sorted, merged with the head's records ---
  const sorted = v3.sortRows(input.rows, fs, { prefix: `tmp/sort-${crypto.randomUUID()}/` })
  const headRecords = v3.exportAll(c.data, view, { from: PAST_RESERVED })
  const dataRows: v3.LineRow[] = []
  const outIt = peekable(sorted)
  const headIt = peekable(headRecords)
  for (;;) {
    const o = await outIt.peek()
    const h = await headIt.peek()
    if (!o && !h) break
    const cmp = !o ? 1 : !h ? -1 : v3.compareKeys(o.type, o.id, h.type, h.id)
    if (o && o.type.startsWith('$'))
      throw new CliError(`Output row ${o.type}/${o.id}: reserved types are not written by scripts`)
    if (cmp < 0) {
      // Only in the output: the last row for a key wins.
      const row = await lastOf(outIt)
      if (row.kind === 'r') {
        dataRows.push(row)
        stats.added++
      }
    } else if (cmp > 0) {
      await headIt.next()
      if (input.mode === 'set' && inScope(input, h!.type, h!.line)) {
        dataRows.push(v3.removalRow(h!.id, h!.type))
        stats.removed++
      }
    } else {
      const row = await lastOf(outIt)
      await headIt.next()
      if (row.kind === 'x') {
        dataRows.push(row)
        stats.removed++
      } else if (sha256Hex(row.line) !== h!.hash) {
        dataRows.push(row)
        stats.changed++
      }
    }
  }
  if (dropped.length > 0) {
    const left = await v3.counts(c.data, view, { from: PAST_RESERVED })
    for (const t of dropped) {
      const keptRows =
        (left.get(t)?.records ?? 0) - dataRows.filter((r) => r.type === t && r.kind === 'x').length
      if (keptRows > 0)
        throw new CliError(
          `schemas/${t}.json is gone, but ${keptRows} ${t} records remain: put it back, or remove them`,
        )
    }
  }
  if (schemaRows.length + dataRows.length === 0) return { version: null, stats }

  const files = await v3.buildFiles([...schemaRows, ...dataRows], v3.storeTarget(fs))
  const refs = files.map((f) => refOf(f))
  // The checks the authority will make: every record against its schema, and records carried
  // over under a schema that tightened. A version it would refuse is not saved.
  let bump: 'major' | 'minor' | 'patch'
  try {
    bump = (await v3.checkUpload(c.data, view, refs, { verify: false, checkAssets: false })).bump
  } catch (err) {
    if (err instanceof v3.UploadError)
      throw new CliError(`${c.key}: not saved:\n  ${err.problems.join('\n  ')}`)
    throw err
  }
  const change = await v3.makeChange(cid, {
    files: refs,
    base: head?.id ?? null,
    message: input.message,
  })
  const version = await v3.buildCommit({
    collection: cid,
    previous: head,
    change,
    bump,
    createdAt: input.now,
  })
  if (!(await createObject(fs, v3.commitKey(cid, version.commit.number), version.bytes)))
    throw new CliError(
      `${c.key}: version ${version.commit.number} was saved by something else meanwhile; run again`,
    )
  await v3.writeCommitHint(fs, cid, version.commit.number)
  const state = c.store.state(cid)
  state.versions[version.id] = {
    change: crypto.randomUUID(),
    savedAt: input.now.toISOString(),
    message: input.message,
    stats: { added: stats.added, changed: stats.changed, removed: stats.removed },
    ...(input.run ? { run: input.run } : {}),
  }
  c.store.setState(cid, state)
  return { version, stats }
}

interface Peekable<T> {
  peek(): Promise<T | undefined>
  next(): Promise<T | undefined>
}

function peekable<T>(it: AsyncIterable<T>): Peekable<T> {
  const iter = it[Symbol.asyncIterator]()
  let held: { v: T | undefined } | null = null
  return {
    async peek() {
      if (!held) {
        const r = await iter.next()
        held = { v: r.done ? undefined : r.value }
      }
      return held.v
    },
    async next() {
      const v = await this.peek()
      held = null
      return v
    },
  }
}

/** The last of a run of rows with the same key. */
async function lastOf(it: Peekable<v3.LineRow>): Promise<v3.LineRow> {
  let row = (await it.next())!
  for (let n = await it.peek(); n && n.type === row.type && n.id === row.id; n = await it.peek())
    row = (await it.next())!
  return row
}

// --- Changing versions not yet pushed ---

/** The bump between two semvers that follow one another. */
export function bumpBetween(before: string | null, after: string): 'major' | 'minor' | 'patch' {
  for (const b of ['major', 'minor', 'patch'] as const)
    if (v3.nextSemver(before, b) === after) return b
  throw new CliError(`${after} does not follow ${before}`)
}

/**
 * Put commits in the log in place of those from `from` on: the old ones are deleted, the
 * new written, and the notes moved to the new ids.
 */
export async function rewrite(
  c: Coll,
  from: number,
  commits: StoredCommit[],
  ids: Map<string, string>,
  notes?: (state: CollectionState) => void,
): Promise<void> {
  const cid = cidOf(c)
  const fs = c.store.fs
  const head = await v3.headNumber(fs, cid)
  for (let n = head; n >= from; n--) {
    await fs.delete(v3.receiptKey(cid, n))
    await fs.delete(v3.commitKey(cid, n))
  }
  for (const s of commits) {
    if (!(await createObject(fs, v3.commitKey(cid, s.commit.number), s.bytes)))
      throw new CliError(`${c.key}: commit ${s.commit.number} appeared while rewriting`)
  }
  await v3.writeCommitHint(fs, cid, commits.at(-1)?.commit.number ?? from - 1)
  const state = c.store.state(cid)
  for (const [old, now] of ids) {
    const note = state.versions[old]
    if (note) {
      state.versions[now] = note
      delete state.versions[old]
    }
  }
  notes?.(state)
  c.store.setState(cid, state)
}

async function previousOf(c: Coll, number: number): Promise<StoredCommit | null> {
  return number <= 1 ? null : v3.readCommit(c.store.fs, cidOf(c), number - 1)
}

/** The unpushed version a number names (default the newest), or why it can't be changed. */
async function unpushedAt(c: Coll, number?: number): Promise<{ list: StoredCommit[]; at: number }> {
  const list = await unpushedOf(c)
  if (list.length === 0) throw new CliError(`${c.key} has no versions that are not pushed`)
  const n = number ?? list.at(-1)!.commit.number
  const at = list.findIndex((s) => s.commit.number === n)
  if (at < 0)
    throw new CliError(`Version ${n} of ${c.key} is pushed, or not here: pushed versions are fixed`)
  return { list, at }
}

/** Drop the newest version not yet pushed. */
export async function undo(c: Coll): Promise<StoredCommit> {
  const { list } = await unpushedAt(c)
  const last = list.at(-1)!
  await rewrite(c, last.commit.number, [], new Map(), (s) => delete s.versions[last.id])
  await dropUnusedFiles(
    c.store,
    v3.commitFiles(last.commit).map((f) => f.id),
  )
  return last
}

/** Change the message of a version not yet pushed; the versions after it are built again. */
export async function reword(c: Coll, number: number | undefined, message: string, now: Date) {
  const { list, at } = await unpushedAt(c, number)
  const target = list[at]!
  const previous = await previousOf(c, target.commit.number)
  const ch = target.commit.changes[0]!
  const first = await v3.buildCommit({
    collection: cidOf(c),
    previous,
    change: { ...ch, message },
    bump: bumpBetween(previous?.commit.semver ?? null, target.commit.semver),
    createdAt: now,
  })
  const rest = list.slice(at + 1)
  const ids = new Map([[target.id, first.id]])
  // The versions after it follow the same contents, so each keeps its kind of change; a
  // base that named the reworded version names its new id.
  const fixed = await rebase(c, rest, first, ids, now)
  await rewrite(c, target.commit.number, [first, ...fixed], ids, (s) => {
    const note = s.versions[first.id]
    if (note) note.message = message
  })
  return first
}

/** Build `rest` again on `onto`, each with its own bump, bases mapped through `ids`. */
async function rebase(
  c: Coll,
  rest: StoredCommit[],
  onto: StoredCommit | null,
  ids: Map<string, string>,
  now: Date,
): Promise<StoredCommit[]> {
  const out: StoredCommit[] = []
  let previous = onto
  for (let i = 0; i < rest.length; i++) {
    const s = rest[i]!
    const before = i === 0 ? null : rest[i - 1]!
    const ch = s.commit.changes[0]!
    const base = ch.base === null ? null : (ids.get(ch.base) ?? ch.base)
    const prevSemver = before
      ? before.commit.semver
      : ((await previousOf(c, s.commit.number))?.commit.semver ?? null)
    const next = await v3.buildCommit({
      collection: cidOf(c),
      previous,
      change: { ...ch, base },
      bump: bumpBetween(prevSemver, s.commit.semver),
      createdAt: now,
    })
    ids.set(s.id, next.id)
    out.push(next)
    previous = next
  }
  return out
}

/**
 * Merge the versions not yet pushed from `from` (default the first of them) through the
 * newest into one. The states in between are never uploaded: their files are deleted.
 */
export async function squash(c: Coll, from: number | undefined, message: string | null, now: Date) {
  const { list, at } = await unpushedAt(c, from ?? (await unpushedOf(c))[0]?.commit.number)
  const merged = list.slice(at)
  if (merged.length < 2) throw new CliError('Squash needs two versions or more')
  const cid = cidOf(c)
  const first = merged[0]!
  const previous = await previousOf(c, first.commit.number)
  const headView = await v3.openView(c.data, cid)
  const base = previous
    ? await v3.openView(c.data, cid, { version: previous.commit.number })
    : emptyView(cid)
  // What the merged versions change, taken together: each key's state at the newest.
  const rows: v3.LineRow[] = []
  for await (const ch of v3.changes(c.data, headView, previous?.commit.number ?? 0, {
    before: true,
  })) {
    if (!ch.after) {
      rows.push(v3.removalRow(ch.id, ch.type))
      continue
    }
    const line = await ch.line()
    if (!line) throw new CliError(`${ch.type}/${ch.id} is withheld and cannot be squashed`)
    rows.push({ kind: 'r', type: ch.type, id: ch.id, line: dec.decode(line) })
  }
  const notes = c.store.state(cid).versions
  const msg =
    message ??
    merged
      .map((s) => s.commit.changes[0]!.message)
      .filter(Boolean)
      .join('; ')
      .slice(0, 2000) ??
    null
  if (rows.length === 0) {
    // They cancel out: nothing is left to save.
    await rewrite(c, first.commit.number, [], new Map(), (s) =>
      merged.forEach((m) => delete s.versions[m.id]),
    )
    await dropUnusedFiles(
      c.store,
      merged.flatMap((s) => v3.commitFiles(s.commit).map((f) => f.id)),
    )
    return null
  }
  const files = await v3.buildFiles(rows, v3.storeTarget(c.store.fs))
  const refs = files.map((f) => refOf(f))
  const bump = await bumpAgainst(c.data, base, refs)
  const change = await v3.makeChange(cid, {
    files: refs,
    base: previous?.id ?? null,
    message: msg || null,
  })
  const version = await v3.buildCommit({ collection: cid, previous, change, bump, createdAt: now })
  const sum = { added: 0, changed: 0, removed: 0 }
  for (const s of merged) {
    const st = notes[s.id]?.stats
    if (st) for (const k of ['added', 'changed', 'removed'] as const) sum[k] += st[k]
  }
  await rewrite(c, first.commit.number, [version], new Map(), (s) => {
    const firstNote = s.versions[first.id]
    for (const m of merged) delete s.versions[m.id]
    s.versions[version.id] = {
      change: firstNote?.change ?? crypto.randomUUID(),
      savedAt: now.toISOString(),
      message: msg || null,
      stats: sum,
      merged: merged
        .slice(1)
        .map((m) => notes[m.id]?.change)
        .filter(Boolean),
    } as VersionNote
  })
  const kept = new Set(refs.map((r) => r.id))
  await dropUnusedFiles(
    c.store,
    merged.flatMap((s) => v3.commitFiles(s.commit).map((f) => f.id)).filter((id) => !kept.has(id)),
  )
  return version
}

/**
 * Replay versions not yet pushed on the authority's newest, which is already in the log in
 * their place: each built again on the one before, with the kind of change it now is, and
 * written before the next is built (its bump reads the version before it). Notes move to
 * the new ids.
 */
export async function replayOnto(
  c: Coll,
  unpushed: StoredCommit[],
  onto: StoredCommit | null,
  now: Date,
): Promise<{ from: StoredCommit; to: StoredCommit }[]> {
  const cid = cidOf(c)
  const fs = c.store.fs
  const out: { from: StoredCommit; to: StoredCommit }[] = []
  const ids = new Map<string, string>()
  let previous = onto
  for (const s of unpushed) {
    const view = previous
      ? await v3.openView(c.data, cid, { version: previous.commit.number })
      : emptyView(cid)
    const ch = s.commit.changes[0]!
    const next = await v3.buildCommit({
      collection: cid,
      previous,
      change: { ...ch, base: ch.base === null ? null : (ids.get(ch.base) ?? ch.base) },
      bump: await bumpAgainst(c.data, view, v3.commitFiles(s.commit)),
      createdAt: now,
    })
    if (!(await createObject(fs, v3.commitKey(cid, next.commit.number), next.bytes)))
      throw new CliError(`${c.key}: commit ${next.commit.number} appeared while replaying`)
    await v3.writeCommitHint(fs, cid, next.commit.number)
    ids.set(s.id, next.id)
    out.push({ from: s, to: next })
    previous = next
  }
  const state = c.store.state(cid)
  for (const [old, now2] of ids) {
    const note = state.versions[old]
    if (note) {
      state.versions[now2] = note
      delete state.versions[old]
    }
  }
  c.store.setState(cid, state)
  return out
}

/** Delete record files no commit in this store names any more. */
export async function dropUnusedFiles(store: LocalStore, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const inUse = await filesInUse(store)
  let n = 0
  for (const id of new Set(ids)) {
    if (inUse.has(id)) continue
    await store.fs.delete(v3.recordKey(id))
    n++
  }
  return n
}

/** Every file a commit or layout in this store names. */
export async function filesInUse(store: LocalStore): Promise<Set<string>> {
  const out = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await store.fs.list('collections/', cursor)
    for (const key of page.keys) {
      if (!key.endsWith('.json') || key.endsWith('.receipt.json')) continue
      if (!/\/(commits|layouts)\//.test(key)) continue
      const obj = await store.fs.get(key)
      if (!obj) continue
      const j = JSON.parse(await obj.text()) as { changes?: v3.Change[]; files?: v3.FileRef[] }
      for (const ch of j.changes ?? []) for (const f of ch.files) out.add(f.id)
      for (const f of j.files ?? []) out.add(f.id)
    }
    cursor = page.cursor
  } while (cursor)
  return out
}
