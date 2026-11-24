/**
 * Following a v3 collection's log, and fetching the files its versions name (docs/protocol.md,
 * Section 8.3; local-tool-build.md, phase 0). Mounted at /api/collections:
 *
 *   GET /:owner/:slug/commits?after=<n>&limit=<k>   commits after n, each with its receipt
 *   GET /:owner/:slug/commits/:n                   one commit, with its receipt
 *   GET /:owner/:slug/layout                       the current layout file, or null
 *   GET /:owner/:slug/record-files/:id             a sorted-record-file's bytes (Range works)
 *
 * A commit is given as its exact text (`commit`), so a client stores the bytes its version
 * id is the hash of. A client that follows the log reads the current layout and the commits
 * after its `through`, and fetches exactly the files those name; nothing else is served, so
 * knowing a file id is not a way to read it (4.3). Access follows the read routes: a v3
 * collection is readable whole or not at all.
 */
import { sha256Hex, utf8, v3 } from '@underlay/protocol'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { deniedHashes } from '../lib/limits.js'
import type { Ports } from '../ports.js'
import { authorityOf } from '../v3/authority.js'
import { readView } from '../v3/read-cache.js'
import { findVersion } from '../versions/view.js'
import { type CollectionAccess, jsonError, requireCollection } from './access.js'

/** A page of commits: this many unless `limit` asks for fewer or more, never past the cap. */
export const commitPage = {
  defaultCommits: 100,
  maxCommits: 1000,
  /** And no more than this much commit text: a first load's commit names thousands of files. */
  bytes: 4 * 1024 * 1024,
  /** Commits and their receipts read at once. */
  concurrency: 16,
}
const dec = new TextDecoder()
const HEX64 = /^[0-9a-f]{64}$/
const WHOLE = /^\d{1,15}$/

async function v3Read(c: Context<AppEnv>): Promise<CollectionAccess | Response> {
  const access = await requireCollection(c, 'read')
  if (access instanceof Response) return access
  if (access.collection.recordLayout !== 'v3')
    return jsonError(c, 409, 'Commits are for v3 collections; this one syncs with /log and /pack')
  return access
}

/** A commit as these routes give it: its number, id, exact text, and receipt. */
async function entry(ports: Ports, cid: string, n: number) {
  const [s, receipt] = await Promise.all([
    v3.readCommit(ports.stores.v3, cid, n),
    v3.readReceipt(ports.stores.v3, cid, n),
  ])
  return s ? { number: n, id: s.id, commit: dec.decode(s.bytes), receipt } : null
}

/**
 * Commits after `after`, as the commits route and v3's `/log` answer: up to `limit` of them
 * and `commitPage.bytes` of their text, whichever comes first (always at least one). A
 * client goes on from the last number it was given while `more` is true.
 */
export async function commitsAfter(c: Context<AppEnv>, access: CollectionAccess) {
  const ports = c.var.ports
  const cid = access.collection.id
  const afterText = c.req.query('after') ?? '0'
  const limitText = c.req.query('limit') ?? String(commitPage.defaultCommits)
  if (!WHOLE.test(afterText)) return jsonError(c, 400, '"after" is a commit number, 0 or more')
  if (!WHOLE.test(limitText) || Number(limitText) < 1)
    return jsonError(c, 400, '"limit" is a count, 1 or more')
  const after = Number(afterText)
  const limit = Math.min(commitPage.maxCommits, Number(limitText))
  const [head, authority] = await Promise.all([
    v3.headNumber(ports.stores.v3, cid),
    authorityOf(ports, cid),
  ])
  const commits: NonNullable<Awaited<ReturnType<typeof entry>>>[] = []
  const to = Math.min(head, after + limit)
  let bytes = 0
  let last = Math.min(after, head)
  paging: for (let at = after + 1; at <= to; at += commitPage.concurrency) {
    const batch = await v3.inParallel(
      Array.from(
        { length: Math.min(commitPage.concurrency, to - at + 1) },
        (_, i) => () => entry(ports, cid, at + i),
      ),
      commitPage.concurrency,
    )
    for (const e of batch) {
      if (!e) throw new Error(`Commit ${last + 1} of ${cid} is missing`)
      if (commits.length > 0 && bytes + e.commit.length > commitPage.bytes) break paging
      commits.push(e)
      bytes += e.commit.length
      last = e.number
    }
  }
  return c.json({ collection: { id: cid, authority }, head, commits, more: last < head })
}

/** The ids a view names, kept with the view (a cached view is the same object each time). */
const idsOf = new WeakMap<v3.View, Set<string>>()
function names(view: v3.View, id: string): boolean {
  let ids = idsOf.get(view)
  if (!ids) idsOf.set(view, (ids = new Set(view.files.map((f) => f.id))))
  return ids.has(id)
}

/**
 * Is a file one the collection's current layout, or a commit after it, names? Asked of the
 * view the read routes keep for the newest version D1 knows (read-cache.ts), so fetching a
 * version's files does not read the layout and the commits after it once a file. Only on a
 * miss is the bucket asked afresh: a rebuild may have written a layout since the view was
 * kept, and a commit may be in the bucket that D1 has yet to record.
 */
async function namesFile(ports: Ports, access: CollectionAccess, id: string): Promise<boolean> {
  const cid = access.collection.id
  const row = await findVersion(ports.db, cid, 'latest', access.collection.headVersionId)
  const kept = row ? await readView(ports, cid, row) : null
  if (kept && names(kept, id)) return true
  if ((await v3.headNumber(ports.stores.v3, cid)) === 0) return false
  return names(await v3.openView(ports.stores.v3, cid), id)
}

/**
 * Whether each file holds a record the platform withholds, by file id, for one state of the
 * deny list: a file never changes, the deny list does, and a file found clean before a
 * takedown is not clean after it. Kept in this isolate and in the colo's cache
 * (`ports.cache`), both under the deny list's fingerprint, so a change to the list starts
 * every file afresh within the minute the list itself is cached for (lib/limits.ts).
 */
const verdicts = new Map<string, boolean>()
let verdictsFor = ''
const fingerprints = new WeakMap<Set<string>, string>()
const VERDICT_TTL_SECONDS = 24 * 60 * 60
const MAX_VERDICTS = 10_000

function fingerprint(denied: Set<string>): string {
  let f = fingerprints.get(denied)
  if (!f) fingerprints.set(denied, (f = sha256Hex(utf8([...denied].sort().join('\n')))))
  return f
}

/** Does the file hold a record the platform withholds (the deny list)? */
async function holdsDenied(ports: Ports, id: string): Promise<boolean> {
  const denied = await deniedHashes(ports.db)
  if (denied.size === 0) return false
  const list = fingerprint(denied)
  if (list !== verdictsFor) {
    verdicts.clear()
    verdictsFor = list
  }
  const known = verdicts.get(id)
  if (known !== undefined) return known
  const key = `v3withheld/${list}/${id}`
  const warm = await ports.cache.get(key, { maxBytes: 1 }).catch(() => null)
  let holds: boolean
  if (warm?.byteLength === 1) holds = warm[0] === 1
  else {
    holds = false
    const file = await v3.openFile(ports.stores.v3, id)
    const reader = file.reader({ readAhead: 4 * 1024 * 1024 })
    const cursor = new v3.EntryCursor(reader, file.content.labeled ? null : 0)
    await cursor.seek()
    for (; cursor.current && !holds; await cursor.next()) {
      const hash = cursor.current.hash
      holds = hash != null && denied.has(hash)
    }
    await ports.cache
      .put(key, new Uint8Array([holds ? 1 : 0]), { ttlSeconds: VERDICT_TTL_SECONDS })
      .catch(() => {})
  }
  if (verdicts.size >= MAX_VERDICTS) verdicts.clear()
  verdicts.set(id, holds)
  return holds
}

function parseRange(header: string | undefined, size: number) {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    // The last n bytes; none of them is no range a response can describe.
    const n = Math.min(size, Number(m[2]))
    return n === 0 ? ('unsatisfiable' as const) : { offset: size - n, length: n }
  }
  const from = Number(m[1])
  const to = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]))
  if (from >= size || to < from) return 'unsatisfiable' as const
  return { offset: from, length: to - from + 1 }
}

/**
 * Caching for a file's bytes, as for a version's data (api/versions.ts, decision D2 of
 * alignment review 2): a file never changes, but who may read it does (a collection made
 * private, a record withheld), so an anonymous read is public for ten minutes, not for
 * good. Members' reads are private.
 */
const fileCaching = (c: Context<AppEnv>, access: CollectionAccess) =>
  !access.collection.public
    ? 'private'
    : c.var.principal
      ? 'private, max-age=3600'
      : 'public, max-age=600, stale-while-revalidate=60'

export function commitRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/:owner/:slug/commits', async (c) => {
    const access = await v3Read(c)
    if (access instanceof Response) return access
    return commitsAfter(c, access)
  })

  app.get('/:owner/:slug/commits/:n', async (c) => {
    const access = await v3Read(c)
    if (access instanceof Response) return access
    const n = WHOLE.test(c.req.param('n')) ? Number(c.req.param('n')) : 0
    if (n < 1) return jsonError(c, 400, 'A commit number is 1 or more')
    const e = await entry(c.var.ports, access.collection.id, n)
    if (!e) return jsonError(c, 404, `Commit ${n} not found`)
    return c.json(e)
  })

  app.get('/:owner/:slug/layout', async (c) => {
    const access = await v3Read(c)
    if (access instanceof Response) return access
    const layout = await v3.findLayout(c.var.ports.stores.v3, access.collection.id)
    return c.json({ layout })
  })

  app.get('/:owner/:slug/record-files/:id', async (c) => {
    const access = await v3Read(c)
    if (access instanceof Response) return access
    const id = c.req.param('id')
    if (!HEX64.test(id)) return jsonError(c, 400, 'A file id is 64 hex characters')
    const ports = c.var.ports
    const store = ports.stores.v3
    if (!(await namesFile(ports, access, id)))
      return jsonError(c, 404, 'No version of this collection names that file now')
    if (await holdsDenied(ports, id))
      return jsonError(
        c,
        451,
        'This file holds records that are withheld; read them through the records routes',
      )
    let key = v3.recordKey(id)
    let head = await store.head(key)
    if (!head) {
      // The sweep moves a file to trash/ before deleting it; a reader looks there too.
      key = `trash/${key}`
      head = await store.head(key)
    }
    if (!head) return jsonError(c, 404, 'File not found')
    const range = parseRange(c.req.header('range'), head.size)
    if (range === 'unsatisfiable')
      return c.body(null, 416, { 'content-range': `bytes */${head.size}` })
    const obj = await store.get(key, range ?? undefined)
    if (!obj) return jsonError(c, 404, 'File not found')
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(obj.size),
      'accept-ranges': 'bytes',
      etag: `"${id}"`,
      'cache-control': fileCaching(c, access),
    }
    if (range)
      headers['content-range'] = `bytes ${range.offset}-${range.offset + obj.size - 1}/${head.size}`
    return new Response(obj.body, { status: range ? 206 : 200, headers })
  })

  return app
}
