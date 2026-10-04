/**
 * Tree sync, the server side (edge-redesign-build.md, "Tree sync"), mounted at
 * /api/collections. Pull-only: clients and mirror nodes fetch packs and the log.
 *
 *   GET /:owner/:slug/versions/:n/pack?base=<n>&sets=public|all
 *       a tar of the objects version :n reaches that `base` doesn't
 *   GET /:owner/:slug/log?after=<seq>&limit=<n>
 *       collection.json (with the signing keys) and log entries after `after`
 *
 * Access follows the read path: a collection the caller can't read is a 404,
 * and `sets=all` needs the private sets. The base must be a version of the same
 * collection, so what a pack leaves out says nothing about anything the caller
 * couldn't read anyway.
 */
import {
  type LogEntry,
  packVersion,
  readCollectionInfo,
  readHead,
  readLogEntry,
  tarStream,
} from '@underlay/protocol'
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { findVersion } from '../versions/view.js'
import { jsonError, requireCollection } from './access.js'

const MAX_LOG_ENTRIES = 1000

export function syncRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/:owner/:slug/versions/:n/pack', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const sets = c.req.query('sets') ?? 'public'
    if (sets !== 'public' && sets !== 'all') return jsonError(c, 400, 'sets is public or all')
    if (sets === 'all' && !access.sets.includes('private')) {
      return jsonError(c, 403, 'The private sets need membership in the owning organization')
    }
    const { db } = c.var.ports
    const id = access.collection.id
    const head = access.collection.headVersionId
    const version = await findVersion(db, id, c.req.param('n'), head)
    if (!version) return jsonError(c, 404, `Version ${c.req.param('n')} not found`)
    const baseParam = c.req.query('base')
    const base = baseParam ? await findVersion(db, id, baseParam, head) : null
    if (baseParam && !base) return jsonError(c, 404, `Base version ${baseParam} not found`)

    const repo = await c.var.ports.stores.forCollection(id)
    const objects = packVersion(repo, version.hash, { base: base?.hash ?? null, sets })
    const entries = (async function* () {
      for await (const o of objects) {
        yield {
          name: o.key,
          size: o.bytes.byteLength,
          body: async function* () {
            yield o.bytes
          },
        }
      }
    })()
    return new Response(tarStream(entries), {
      headers: {
        'content-type': 'application/x-tar',
        'x-underlay-version': version.hash,
        'x-underlay-base': base?.hash ?? '',
        'x-underlay-sets': sets,
      },
    })
  })

  app.get('/:owner/:slug/log', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const after = Math.max(0, Number(c.req.query('after') ?? 0) || 0)
    const limit = Math.min(
      MAX_LOG_ENTRIES,
      Math.max(1, Number(c.req.query('limit')) || MAX_LOG_ENTRIES),
    )
    const id = access.collection.id
    const repo = await c.var.ports.stores.forCollection(id)
    const [collection, head] = await Promise.all([readCollectionInfo(repo, id), readHead(repo, id)])
    const entries: LogEntry[] = []
    for (let seq = after + 1; head && seq <= head.seq && entries.length < limit; seq++) {
      const e = await readLogEntry(repo, id, seq)
      if (!e) break
      entries.push(e)
    }
    return c.json({ collection, head, entries })
  })

  return app
}
