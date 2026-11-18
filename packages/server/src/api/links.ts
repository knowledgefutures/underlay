/**
 * Following a link (record-references.md): where a `ul:` id, and where it was found, can be
 * read on this server.
 *
 *   GET /api/links/resolve?to=<ul: id>[&collection=<collection id>][&type=…&id=…]
 *
 * Redirects to the page (or, for an asset, the download) that shows the target, or answers
 * `{"url"}` to a caller that asks for JSON. Only what the caller may read is found: a
 * collection they can't read is "not found", as everywhere else.
 *
 * - `ul:ver:` with a collection: that version's page.
 * - `ul:rec:` with a collection, type and id: the record's page, at the newest version, with
 *   `hash` so the page can show which of its versions the link pins.
 * - `ul:rec:` otherwise: the record-by-hash page.
 * - `ul:asset:` with a collection: the asset, through the collection's file route.
 */
import { parseHashInput } from '@underlay/protocol'
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { findVersion } from '../versions/view.js'
import { collectionAccess, ID_OWNER, jsonError } from './access.js'

const bare = (semver: string) => semver.replace(/^v/, '')
const seg = encodeURIComponent

export function linkRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/api/links/resolve', async (c) => {
    const to = parseHashInput(c.req.query('to') ?? '')
    if (!to || to.kind === null)
      return jsonError(
        c,
        400,
        '"to" must be a ul: id: ul:rec:<hex>, ul:asset:<hex> or ul:ver:<hex>',
      )
    const cid = c.req.query('collection')
    const type = c.req.query('type')
    const id = c.req.query('id')
    const answer = (url: string) =>
      (c.req.header('accept') ?? '').includes('application/json')
        ? c.json({ url })
        : c.redirect(url, 302)

    if (!cid) {
      if (to.kind === 'rec') return answer(`/records/${to.hash}`)
      return jsonError(
        c,
        404,
        'A version or asset is found through its collection: add "collection"',
      )
    }
    const access = await collectionAccess(c.var.ports.db, c.var.principal, ID_OWNER, cid)
    if (!access || !access.canRead) return jsonError(c, 404, 'Collection not found')
    const page = `/${seg(access.owner.slug)}/${seg(access.collection.slug)}`

    if (to.kind === 'ver') {
      const v = await findVersion(
        c.var.ports.db,
        access.collection.id,
        to.form === 'ulv2' ? `ulv2:${to.hash}` : `ul:ver:${to.hash}`,
        access.collection.headVersionId,
      )
      if (!v) return jsonError(c, 404, 'Version not found')
      return answer(`${page}/v/${bare(v.semver)}`)
    }
    if (to.kind === 'asset')
      return answer(`/api/collections/${ID_OWNER}/${seg(access.collection.id)}/files/${to.hash}`)
    if (type && id)
      return answer(`${page}/v/latest/records/${seg(type)}/${seg(id)}?hash=${to.hash}`)
    return answer(`/records/${to.hash}`)
  })

  return app
}
