/**
 * Collections (docs/protocol-v3.md, Section 8): a description, commits,
 * layouts, and the files and assets they name. A collection never points at
 * another: a fork copies its parent's commits and layout, which are small, and
 * names the same sorted-record-files, which are stored once.
 */
import { jcs } from '../jcs.js'
import { createObject, type Store } from '../repo/types.js'
import { recordKey } from './build.js'
import { ASSET_TYPE } from './constants.js'
import {
  checkCollectionId,
  collectionPrefix,
  commitKey,
  createLayout,
  descriptionKey,
  findLayout,
  headNumber,
  type Layout,
  readCommit,
  readLatest,
  writeLatest,
} from './log.js'
import { mergeGroups, openView, type ReadOptions } from './read.js'
import { currentFiles } from './rebuild.js'
import { inParallel } from './util.js'

export interface Description {
  id: string
  createdAt: string
  /** For a fork: the collection, commit number, and version id it began from. */
  forkedFrom?: { collection: string; commit: number; id: string }
  /**
   * The collections whose ids this one's earlier commits carry, oldest first,
   * each with the last commit number that carries it.
   */
  lineage?: [collection: string, through: number][]
  /** Anything else the server keeps here: a name, an owner, signing keys. */
  [member: string]: unknown
}

export class CollectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollectionError'
  }
}

export async function readDescription(store: Store, id: string): Promise<Description | null> {
  const obj = await store.get(descriptionKey(id))
  return obj ? (JSON.parse(await obj.text()) as Description) : null
}

/** Create a collection: its description, written only if no collection has the id. */
export async function createCollection(
  store: Store,
  id: string,
  extra: Record<string, unknown> = {},
  now: () => Date = () => new Date(),
): Promise<Description> {
  checkCollectionId(id)
  const description: Description = { ...extra, id, createdAt: now().toISOString() }
  if (!(await createObject(store, descriptionKey(id), jcs(description)))) {
    throw new CollectionError(`Collection ${id} already exists`)
  }
  return description
}

/**
 * Delete a collection: its description first, so it is gone at once, then its
 * commits, layouts, and hint. The files and assets it named stay until a sweep
 * finds that nothing lists them.
 */
export async function deleteCollection(store: Store, id: string): Promise<number> {
  checkCollectionId(id)
  await store.delete(descriptionKey(id))
  let deleted = 0
  let cursor: string | undefined
  do {
    const page = await store.list(collectionPrefix(id), cursor)
    await inParallel(
      page.keys.map((k) => () => store.delete(k)),
      16,
    )
    deleted += page.keys.length
    cursor = page.cursor
  } while (cursor !== undefined)
  return deleted
}

export interface ForkOptions {
  /** The commit to fork at; the newest by default. At or after the parent's layout's `through`. */
  at?: number
  extra?: Record<string, unknown>
  now?: () => Date
}

export interface ForkResult {
  description: Description
  /** Small objects written: the description, the commits, the layout, the hint. */
  objects: number
  /** Bytes written. No sorted-record-file or asset is copied. */
  bytes: number
}

/**
 * Fork a collection: copy its commits up to a point and its current layout,
 * under a new id. The fork names the same files as its parent, so it costs the
 * bytes of the commits and the layout, whatever the collection's size.
 */
export async function forkCollection(
  store: Store,
  parent: string,
  fork: string,
  opts: ForkOptions = {},
): Promise<ForkResult> {
  checkCollectionId(parent)
  checkCollectionId(fork)
  const now = opts.now ?? (() => new Date())
  const latest = await readLatest(store, parent)
  let layout: Layout | null
  let head: number
  try {
    layout = await findLayout(store, parent, latest)
    head = await headNumber(store, parent, latest)
  } catch (err) {
    // Its newest layout or commit went away between being found and being read.
    throw new CollectionError(`${parent} was deleted during the fork: ${(err as Error).message}`)
  }
  const at = opts.at ?? head
  if (at < 1 || at > head) throw new CollectionError(`${parent} has no commit ${at}`)
  if (layout && at < layout.through) {
    throw new CollectionError(
      `${parent} can be forked at commit ${layout.through} or later; rebuilt files hold rows up to it`,
    )
  }
  const point = await readCommit(store, parent, at)
  if (!point) throw new CollectionError(`${parent} has no commit ${at}`)
  const parentDescription = await readDescription(store, parent)
  const description: Description = {
    ...opts.extra,
    id: fork,
    createdAt: now().toISOString(),
    forkedFrom: { collection: parent, commit: at, id: point.id },
    lineage: [...(parentDescription?.lineage ?? []), [parent, at]],
  }
  const descriptionBytes = jcs(description)
  if (!(await createObject(store, descriptionKey(fork), descriptionBytes))) {
    throw new CollectionError(`Collection ${fork} already exists`)
  }
  let bytes = descriptionBytes.length
  let objects = 1
  try {
    const copied = await inParallel(
      Array.from({ length: at }, (_, i) => async () => {
        const obj = await store.get(commitKey(parent, i + 1))
        if (!obj) throw new CollectionError(`${parent} lost commit ${i + 1} during the fork`)
        const body = await obj.bytes()
        await store.put(commitKey(fork, i + 1), body, { contentType: 'application/json' })
        return body.byteLength
      }),
      16,
    )
    bytes += copied.reduce((n, b) => n + b, 0)
    objects += at
    if (layout) {
      const copy: Layout = {
        ...layout,
        collection: fork,
        number: 1,
        createdAt: now().toISOString(),
      }
      if (!(await createLayout(store, copy))) throw new CollectionError('Fork layout exists')
      bytes += jcs(copy).length
      objects++
    }
    await writeLatest(store, fork, { commit: at, layout: layout ? 1 : 0 })
    objects += layout ? 2 : 1
  } catch (err) {
    await deleteCollection(store, fork).catch(() => {})
    throw err
  }
  return { description, objects, bytes }
}

export interface CollectionStats {
  /** The newest commit and layout. */
  head: number
  layout: number
  files: number
  entries: number
  /** Bytes of lines in the files it lists, uncompressed. */
  lineBytes: number
  /** Stored bytes of the files it lists: what it is billed for, shared or not. */
  storedBytes: number
}

/**
 * What a collection lists, from its layout and later commits. Stored sizes
 * come from the layout where it has them, else from a head request per file.
 */
export async function collectionStats(store: Store, id: string): Promise<CollectionStats> {
  const { layout, head, files } = await currentFiles(store, id)
  const sizes = await inParallel(
    files.map((f) => async () => f.size ?? (await store.head(recordKey(f.id)))?.size ?? 0),
    16,
  )
  return {
    head,
    layout: layout?.number ?? 0,
    files: files.length,
    entries: files.reduce((n, f) => n + f.entries, 0),
    lineBytes: files.reduce((n, f) => n + f.bytes, 0),
    storedBytes: sizes.reduce((n, b) => n + b, 0),
  }
}

/** The assets a version lists: each `$asset` record's asset hash, with the record's own hash. */
export async function* listedAssets(
  store: Store,
  collection: string,
  opts: ReadOptions & { version?: number } = {},
): AsyncGenerator<{ hash: string; record: string }> {
  const view = await openView(
    store,
    collection,
    opts.version === undefined ? {} : { version: opts.version },
  )
  for await (const group of mergeGroups(store, view, { type: ASSET_TYPE }, opts)) {
    const e = group[group.length - 1]!.entry
    if (e.kind !== 'x') yield { hash: e.id, record: e.hash! }
  }
}
