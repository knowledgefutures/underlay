/**
 * Following a v3 collection's log, and fetching the files its versions name (protocol-v3
 * Section 4.8; local-tool-build.md, phase 0). Mounted at /api/collections:
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
import { type Store, v3 } from '@underlay/protocol'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { deniedHashes } from '../lib/limits.js'
import { authorityOf } from '../v3/uploads.js'
import { type CollectionAccess, jsonError, requireCollection } from './access.js'

const MAX_COMMITS = 1000
const dec = new TextDecoder()
const HEX64 = /^[0-9a-f]{64}$/

async function v3Read(c: Context<AppEnv>): Promise<CollectionAccess | Response> {
  const access = await requireCollection(c, 'read')
  if (access instanceof Response) return access
  if (access.collection.recordLayout !== 'v3')
    return jsonError(c, 409, 'Commits are for v3 collections; this one syncs with /log and /pack')
  return access
}

/** A commit as these routes give it: its number, id, exact text, and receipt. */
async function entry(ports: AppEnv['Variables']['ports'], cid: string, s: v3.StoredCommit) {
  return {
    number: s.commit.number,
    id: s.id,
    commit: dec.decode(s.bytes),
    receipt: await v3.readReceipt(ports.stores.v3, cid, s.commit.number),
  }
}

/** Commits after `after`, as the commits route and v3's `/log` answer. */
export async function commitsAfter(c: Context<AppEnv>, access: CollectionAccess) {
  const ports = c.var.ports
  const store = ports.stores.v3
  const cid = access.collection.id
  const after = Math.max(0, Number(c.req.query('after') ?? 0) || 0)
  const limit = Math.min(MAX_COMMITS, Math.max(1, Number(c.req.query('limit')) || MAX_COMMITS))
  const head = await v3.headNumber(store, cid)
  const commits = []
  const to = Math.min(head, after + limit)
  if (to > after) {
    for await (const s of v3.readLog(store, cid, after + 1, to))
      commits.push(await entry(ports, cid, s))
  }
  return c.json({
    collection: { id: cid, authority: await authorityOf(ports, cid) },
    head,
    commits,
    more: to < head,
  })
}

/** Is a file one the collection's current layout, or a commit after it, names? */
const named = new Map<string, Set<string>>()
async function namesFile(store: Store, cid: string, id: string) {
  const view = await v3.openView(store, cid)
  const key = `${cid}@${view.head}/${view.layout}`
  let ids = named.get(key)
  if (!ids) {
    ids = new Set(view.files.map((f) => f.id))
    if (named.size > 200) named.clear()
    named.set(key, ids)
  }
  return ids.has(id)
}

/** Files found to hold no withheld record, by file id (files never change). */
const clean = new Set<string>()

/** Does the file hold a record the platform withholds (the deny list)? */
async function holdsDenied(ports: AppEnv['Variables']['ports'], id: string): Promise<boolean> {
  if (clean.has(id)) return false
  const denied = await deniedHashes(ports.db)
  if (denied.size === 0) return false
  const file = await v3.openFile(ports.stores.v3, id)
  const reader = file.reader({ readAhead: 4 * 1024 * 1024 })
  const cursor = new v3.EntryCursor(reader, file.content.labeled ? null : 0)
  await cursor.seek()
  for (; cursor.current; await cursor.next()) {
    if (cursor.current.hash && denied.has(cursor.current.hash)) return true
  }
  if (clean.size > 10_000) clean.clear()
  clean.add(id)
  return false
}

function parseRange(header: string | undefined, size: number) {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const n = Math.min(size, Number(m[2]))
    return { offset: size - n, length: n }
  }
  const from = Number(m[1])
  const to = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]))
  if (from >= size || to < from) return 'unsatisfiable' as const
  return { offset: from, length: to - from + 1 }
}

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
    const n = Number(c.req.param('n'))
    if (!Number.isSafeInteger(n) || n < 1) return jsonError(c, 400, 'A commit number is 1 or more')
    const s = await v3.readCommit(c.var.ports.stores.v3, access.collection.id, n)
    if (!s) return jsonError(c, 404, `Commit ${n} not found`)
    return c.json(await entry(c.var.ports, access.collection.id, s))
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
    if (!(await namesFile(store, access.collection.id, id)))
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
      // A file never changes: its id is its content's.
      'cache-control': access.collection.public ? 'public, max-age=31536000, immutable' : 'private',
    }
    if (range)
      headers['content-range'] = `bytes ${range.offset}-${range.offset + obj.size - 1}/${head.size}`
    return new Response(obj.body, { status: range ? 206 : 200, headers })
  })

  return app
}
