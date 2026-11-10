/**
 * The deletion sweep and storage accounting (docs/protocol-v3.md, Section 9).
 *
 * Sorted-record-files and assets are stored once and shared, so nothing is
 * deleted when a collection stops naming it. One sweeper, run in passes, finds
 * what no collection lists:
 *
 *   1. Walk every collection (one streaming listing of `collections/`) and write
 *      down each file its newest layout, or a commit after it, names.
 *   2. Sort that, and merge it against a listing of `records/` and `assets/`.
 *   3. Condemn what nothing lists. Move to `trash/` what was condemned on an
 *      earlier pass, at least a grace period ago, and is still unlisted. Move
 *      back anything in `trash/` that is listed again. Delete from `trash/` what
 *      has been there longer than a second period.
 *
 * An object's age is never the test: a fork can copy a layout just before its
 * parent's next layout drops a file. Nothing is deleted outright from the shared
 * folders, so a wrong call is undone on the next pass.
 *
 * The same merge gives the accounting: stored bytes each collection lists
 * (logical, what it is billed for) and stored bytes in the location (physical).
 *
 * Every step is a stream: memory is the sorter's budget and a number per
 * collection, whatever the number of collections or files.
 */
import { putFromParts, readParts, type Store } from '../repo/types.js'
import { recordKey } from './build.js'
import { ASSET_TYPE } from './constants.js'
import { readLines, sortLines, writeLines } from './extsort.js'
import { compareKeys } from './lines.js'
import { commitFiles, readCommit, readLayout } from './log.js'
import { EntryCursor, MissingFileError, SortedFile } from './reader.js'
import { equalParts, inParallel, PART_BYTES } from './util.js'

export interface SweepOptions {
  /** The time, in milliseconds. Injected for tests. */
  now?: () => number
  /** How long something must stay condemned before it is moved to trash. Default 24 hours. */
  graceMs?: number
  /** How long something stays in trash before it is deleted. Default 7 days. */
  trashMs?: number
  /** Collections read at once. */
  concurrency?: number
  /** Memory for sorting the listed ids. */
  memoryBytes?: number
  /** Where the sort spills; the same store by default. */
  scratch?: Store
}

export interface Tally {
  /** Objects in the folder, and their bytes. */
  objects: number
  bytes: number
  /** Of those, objects some collection lists. */
  listed: number
  listedBytes: number
  /** Unlisted and waiting out the grace period. */
  condemned: number
  condemnedBytes: number
  /** Moved to trash by this pass. */
  trashed: number
  trashedBytes: number
  /** Moved back from trash by this pass, because something lists them again. */
  restored: number
  /** Deleted from trash by this pass. */
  purged: number
  purgedBytes: number
  /** Still in trash after this pass. */
  inTrash: number
  inTrashBytes: number
  /** Listed by a collection but in neither the folder nor trash. Always 0 unless data was lost. */
  missing: string[]
}

export interface SweepResult {
  pass: number
  collections: number
  /** For each collection: the files it lists and their stored bytes, shared or not. */
  logical: Map<string, { files: number; bytes: number }>
  records: Tally
  assets: Tally
}

const DAY = 24 * 60 * 60 * 1000
const LEDGER_PREFIX = 'sweep/ledger-'

/**
 * The sweep's state is its ledger: one line per condemned or trashed object,
 * written whole by each pass under the pass's number. Nothing is overwritten,
 * so two passes close together never write one key twice. The newest ledger is
 * the state; older ones are deleted once it is written.
 */
interface State {
  pass: number
  ledger: string
  older: string[]
}

async function readState(store: Store): Promise<State | null> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await store.list(LEDGER_PREFIX, cursor)
    keys.push(...page.keys)
    cursor = page.cursor
  } while (cursor !== undefined)
  const ledger = keys.pop()
  if (!ledger) return null
  return { pass: Number.parseInt(ledger.slice(LEDGER_PREFIX.length), 10), ledger, older: keys }
}

const tally = (): Tally => ({
  objects: 0,
  bytes: 0,
  listed: 0,
  listedBytes: 0,
  condemned: 0,
  condemnedBytes: 0,
  trashed: 0,
  trashedBytes: 0,
  restored: 0,
  purged: 0,
  purgedBytes: 0,
  inTrash: 0,
  inTrashBytes: 0,
  missing: [],
})

/** Every object under a prefix, in key order, with its size. */
async function* listObjects(
  store: Store,
  prefix: string,
): AsyncGenerator<{ name: string; size: number }> {
  let cursor: string | undefined
  do {
    const page = await store.list(prefix, cursor)
    for (let i = 0; i < page.keys.length; i++) {
      yield { name: page.keys[i]!.slice(prefix.length), size: page.info?.[i]?.size ?? 0 }
    }
    cursor = page.cursor
  } while (cursor !== undefined)
}

/** Move an object within a store: a server-side copy where it has one, else a streamed one. */
async function moveObject(store: Store, from: string, to: string, size: number): Promise<void> {
  if (store.copy) await store.copy(from, to, size)
  else await putFromParts(store, to, equalParts(readParts(store, from, size, PART_BYTES)))
  await store.delete(from)
}

/** The collections in a location with their newest commit and layout numbers, from one listing. */
async function* collections(
  store: Store,
): AsyncGenerator<{ id: string; commit: number; layout: number }> {
  let current: { id: string; commit: number; layout: number } | null = null
  let cursor: string | undefined
  do {
    const page = await store.list('collections/', cursor)
    for (const key of page.keys) {
      const [, id, kind, name] = key.split('/')
      if (!id) continue
      if (!current || current.id !== id) {
        if (current) yield current
        current = { id, commit: 0, layout: 0 }
      }
      const n = name ? Number.parseInt(name, 10) : NaN
      if (kind === 'commits' && n > current.commit) current.commit = n
      if (kind === 'layouts' && n > current.layout) current.layout = n
    }
    cursor = page.cursor
  } while (cursor !== undefined)
  if (current) yield current
}

/** Results of `fn` over a stream, `n` at a time, in whatever order they finish. */
async function* mapConcurrent<T, R>(
  items: AsyncIterable<T>,
  n: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  const running = new Map<number, Promise<{ id: number; value: R }>>()
  let next = 0
  for await (const item of items) {
    const id = next++
    running.set(
      id,
      fn(item).then((value) => ({ id, value })),
    )
    if (running.size >= n) {
      const done = await Promise.race(running.values())
      running.delete(done.id)
      yield done.value
    }
  }
  while (running.size > 0) {
    const done = await Promise.race(running.values())
    running.delete(done.id)
    yield done.value
  }
}

const coversType = (first: [string, string] | null, last: [string, string] | null, type: string) =>
  first !== null &&
  last !== null &&
  compareKeys(first[0], '', type, '') <= 0 &&
  compareKeys(type, '', last[0], '') <= 0

/** A stream of lines `<name>\t<rest>` grouped by name: each name once, with its rests. */
async function* grouped(
  lines: AsyncIterable<string>,
): AsyncGenerator<{ name: string; rest: string[] }> {
  let cur: { name: string; rest: string[] } | null = null
  for await (const line of lines) {
    const tab = line.indexOf('\t')
    const name = tab === -1 ? line : line.slice(0, tab)
    const rest = tab === -1 ? '' : line.slice(tab + 1)
    if (!cur || cur.name !== name) {
      if (cur) yield cur
      cur = { name, rest: [] }
    }
    cur.rest.push(rest)
  }
  if (cur) yield cur
}

/** One stream of several, each sorted by `name`: for each name in order, what each stream has. */
async function* joined<T extends { name: string }[]>(
  ...streams: { [K in keyof T]: AsyncIterator<T[K]> }
): AsyncGenerator<{ name: string; row: { [K in keyof T]: T[K] | null } }> {
  const heads = await Promise.all(streams.map((s) => s.next()))
  for (;;) {
    let name: string | null = null
    for (const h of heads) {
      if (!h.done && (name === null || h.value.name < name)) name = h.value.name
    }
    if (name === null) return
    const row: unknown[] = []
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i]!
      if (!h.done && h.value.name === name) {
        row.push(h.value)
        heads[i] = await streams[i]!.next()
      } else row.push(null)
    }
    yield { name, row: row as { [K in keyof T]: T[K] | null } }
  }
}

/**
 * One pass of the sweep. Run by one sweeper at a time. Returns what it found
 * and did, and each collection's logical size.
 */
export async function sweep(store: Store, opts: SweepOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? Date.now
  const grace = opts.graceMs ?? DAY
  const trashFor = opts.trashMs ?? 7 * DAY
  const scratch = opts.scratch ?? store
  const sort = opts.memoryBytes === undefined ? {} : { memoryBytes: opts.memoryBytes }
  const started = now()
  const state = await readState(store)
  const pass = (state?.pass ?? 0) + 1
  const tmp = `tmp/sweep-${pass}-${crypto.randomUUID()}/`
  const result: SweepResult = {
    pass,
    collections: 0,
    logical: new Map(),
    records: tally(),
    assets: tally(),
  }

  // 1. Every file a collection lists: `<file id>\t<collection>\t<1 if it may hold $asset rows>`.
  const listedBy = async (c: { id: string; commit: number; layout: number }): Promise<string[]> => {
    result.collections++
    result.logical.set(c.id, { files: 0, bytes: 0 })
    const lines: string[] = []
    // A collection being deleted may lose objects under us; what is gone lists nothing.
    const layout = c.layout > 0 ? await readLayout(store, c.id, c.layout).catch(() => null) : null
    for (const f of layout?.files ?? []) {
      lines.push(`${f.id}\t${c.id}\t${coversType(f.first, f.last, ASSET_TYPE) ? 1 : 0}`)
    }
    const from = (layout?.through ?? 0) + 1
    const commits = await inParallel(
      Array.from(
        { length: Math.max(0, c.commit - from + 1) },
        (_, i) => () => readCommit(store, c.id, from + i).catch(() => null),
      ),
      8,
    )
    for (const sc of commits) {
      if (!sc) continue
      for (const f of commitFiles(sc.commit)) {
        lines.push(`${f.id}\t${c.id}\t${coversType(f.first, f.last, ASSET_TYPE) ? 1 : 0}`)
      }
    }
    return lines
  }
  const enumerated = (async function* () {
    for await (const lines of mapConcurrent(collections(store), opts.concurrency ?? 16, listedBy)) {
      yield* lines
    }
  })()
  const listedKey = `${tmp}listed`
  await writeLines(
    scratch,
    listedKey,
    sortLines(enumerated, scratch, { ...sort, prefix: `${tmp}sort-files/` }),
  )

  // 2. Every asset a listed file names: the ids of its `$asset` rows, each file read once.
  const assetNames = (async function* () {
    for await (const { name: id, rest } of grouped(readLines(scratch, listedKey))) {
      if (!rest.some((r) => r.endsWith('\t1'))) continue
      let file: SortedFile
      try {
        file = await SortedFile.open(store, recordKey(id), { id })
      } catch (err) {
        if (err instanceof MissingFileError) continue
        throw err
      }
      const cursor = new EntryCursor(
        file.reader({ readAhead: 1024 * 1024 }),
        file.content.labeled ? null : 1,
      )
      await cursor.seek({ type: ASSET_TYPE, id: '' })
      while (cursor.current && cursor.current.type === ASSET_TYPE) {
        if (cursor.current.kind !== 'x') yield cursor.current.id
        await cursor.next()
      }
    }
  })()
  const assetsKey = `${tmp}assets`
  await writeLines(
    scratch,
    assetsKey,
    sortLines(assetNames, scratch, { ...sort, prefix: `${tmp}sort-assets/` }),
  )

  // 3. Merge what is listed against what is stored, what was condemned, and what is in trash.
  const ledgerLines = async function* (prefix: string) {
    if (!state) return
    for await (const line of readLines(store, state.ledger)) {
      if (!line.startsWith(prefix)) continue
      const [key, what, at] = line.split('\t')
      yield { name: key!.slice(prefix.length), what: what as 'c' | 't', at: Number(at) }
    }
  }
  const fold = async function* (
    prefix: 'assets/' | 'records/',
    listed: AsyncGenerator<{ name: string; rest: string[] }>,
    t: Tally,
  ): AsyncGenerator<string> {
    const rows = joined<
      [
        { name: string; size: number },
        { name: string; rest: string[] },
        { name: string; what: 'c' | 't'; at: number },
        { name: string; size: number },
      ]
    >(
      listObjects(store, prefix),
      listed,
      ledgerLines(prefix),
      listObjects(store, `trash/${prefix}`),
    )
    for await (const { name, row } of rows) {
      const [stored, lists, ledger, trashed] = row
      const key = prefix + name
      const trashKey = `trash/${key}`
      let size = stored?.size ?? 0
      let present = stored !== null
      if (lists && !present && trashed) {
        // Listed again after it was moved out: put it back.
        await moveObject(store, trashKey, key, trashed.size)
        t.restored++
        present = true
        size = trashed.size
      } else if (trashed) {
        const since = ledger?.what === 't' ? ledger.at : started
        if (present || (!lists && started - since >= trashFor)) {
          // A copy that is back in the folder, or that nothing has listed for the whole period.
          await store.delete(trashKey)
          if (!present) {
            t.purged++
            t.purgedBytes += trashed.size
          }
        } else {
          t.inTrash++
          t.inTrashBytes += trashed.size
          yield `${key}\tt\t${since}`
        }
      }
      if (lists) {
        if (!present) {
          t.missing.push(key)
          continue
        }
        t.listed++
        t.listedBytes += size
        if (prefix === 'records/') {
          for (const r of lists.rest) {
            const l = result.logical.get(r.slice(0, r.indexOf('\t')))
            if (l) {
              l.files++
              l.bytes += size
            }
          }
        }
      }
      if (!present) continue
      t.objects++
      t.bytes += size
      if (lists) continue
      const since = ledger?.what === 'c' ? ledger.at : started
      if (ledger?.what === 'c' && started - since >= grace) {
        await moveObject(store, key, trashKey, size)
        t.objects--
        t.bytes -= size
        t.trashed++
        t.trashedBytes += size
        t.inTrash++
        t.inTrashBytes += size
        yield `${key}\tt\t${started}`
      } else {
        t.condemned++
        t.condemnedBytes += size
        yield `${key}\tc\t${since}`
      }
    }
  }
  const ledgerKey = `${LEDGER_PREFIX}${String(pass).padStart(8, '0')}`
  const ledger = (async function* () {
    const assets = grouped(readLines(scratch, assetsKey))
    yield* fold('assets/', assets, result.assets)
    yield* fold('records/', grouped(readLines(scratch, listedKey)), result.records)
  })()
  await writeLines(store, ledgerKey, ledger)
  if (state) for (const key of [...state.older, state.ledger]) await store.delete(key)
  await scratch.delete(listedKey)
  await scratch.delete(assetsKey)
  return result
}
