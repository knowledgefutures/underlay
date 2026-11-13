/**
 * Org logos and cover images, stored in the deployment's public assets bucket and
 * linked from `organization.avatar_url` and `cover_image_url` as absolute URLs (as
 * v1 did for logos). Both live in the org's folder, a cover's name prefixed `cover-`
 * so the same picture used for both is two objects. What's stored and what may be
 * deleted is in lib/avatars.ts.
 *
 *   POST   /api/accounts/:owner/avatar    multipart/form-data, one image file
 *   DELETE /api/accounts/:owner/avatar
 *   POST   /api/accounts/:owner/cover     the same, for the page's cover image
 *   DELETE /api/accounts/:owner/cover
 *
 * Owners of the org only, as for its other account routes: a session or an
 * unscoped personal key. Read-only, collection-scoped and org-owned keys can't.
 */
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { avatarFolder, deleteOwnedAvatar, sniffRaster } from '../lib/avatars.js'
import type { PublicAssets } from '../ports.js'
import { jsonError } from './access.js'
import { orgBySlug, requireUser, roleIn } from './accounts.js'
import { BodyTooLarge, readBytes } from './body.js'

/** Logos show at a couple of hundred pixels; GitHub caps profile pictures at 1 MB too. */
export const AVATAR_MAX_BYTES = 1024 * 1024
/** A cover runs the page's width: a 2400px-wide JPEG fits. */
export const COVER_MAX_BYTES = 3 * 1024 * 1024
/** Multipart framing around the file. */
const MULTIPART_OVERHEAD = 64 * 1024
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

type Org = typeof schema.organization.$inferSelect

/** One kind of org image: its route, column, file name prefix and size cap. */
interface ImageKind {
  path: 'avatar' | 'cover'
  column: 'avatarUrl' | 'coverImageUrl'
  prefix: string
  maxBytes: number
  noun: string
}

const KINDS: ImageKind[] = [
  { path: 'avatar', column: 'avatarUrl', prefix: '', maxBytes: AVATAR_MAX_BYTES, noun: 'avatar' },
  {
    path: 'cover',
    column: 'coverImageUrl',
    prefix: 'cover-',
    maxBytes: COVER_MAX_BYTES,
    noun: 'cover image',
  },
]

/** The org, when the caller owns it; otherwise the error response. */
async function ownedOrg(c: Context<AppEnv>, noun: string): Promise<Org | Response> {
  const userId = requireUser(c, true)
  if (userId instanceof Response) return userId
  const org = await orgBySlug(c, c.req.param('owner') ?? '')
  if (!org) return jsonError(c, 404, 'Organization not found')
  if ((await roleIn(c, org.id, userId)) !== 'owner')
    return jsonError(c, 403, `Must be an owner to update the organization ${noun}`)
  return org
}

function assetsOr503(c: Context<AppEnv>): PublicAssets | Response {
  return (
    c.var.ports.publicAssets ??
    jsonError(c, 503, 'Avatar uploads are not configured on this deployment')
  )
}

export function avatarRoutes() {
  const app = new Hono<AppEnv>()

  for (const kind of KINDS) {
    const tooLarge = `Image must be ${kind.maxBytes / 1024 / 1024} MiB or smaller`

    app.post(`/api/accounts/:owner/${kind.path}`, async (c) => {
      const org = await ownedOrg(c, kind.noun)
      if (org instanceof Response) return org
      const assets = assetsOr503(c)
      if (assets instanceof Response) return assets

      const contentType = c.req.header('content-type') ?? ''
      if (!contentType.startsWith('multipart/form-data'))
        return jsonError(c, 400, 'Send the image as multipart/form-data')
      let form: FormData
      try {
        const body = await readBytes(c, kind.maxBytes + MULTIPART_OVERHEAD)
        form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
      } catch (err) {
        if (err instanceof BodyTooLarge) return jsonError(c, 413, tooLarge)
        return jsonError(c, 400, 'Malformed multipart body')
      }
      const file = [...form.values()].find((v): v is File => typeof v !== 'string')
      if (!file) return jsonError(c, 400, 'No file uploaded')
      if (file.size > kind.maxBytes) return jsonError(c, 413, tooLarge)

      // The declared type is the browser's guess from the file name; the bytes decide.
      const bytes = new Uint8Array(await file.arrayBuffer())
      const raster = sniffRaster(bytes)
      if (!ALLOWED_TYPES.includes(file.type) || !raster)
        return jsonError(c, 422, 'Only JPEG, PNG, GIF, and WebP images are allowed')

      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const hash = [...digest].map((v) => v.toString(16).padStart(2, '0')).join('')
      const key = `${avatarFolder(org.id)}${kind.prefix}${hash}.${raster.ext}`
      await assets.store.put(key, bytes, { contentType: raster.type, cacheControl: CACHE_CONTROL })

      const url = `${assets.baseUrl}/${key}`
      await c.var.ports.db
        .update(schema.organization)
        .set({ [kind.column]: url })
        .where(eq(schema.organization.id, org.id))
      if (org[kind.column] !== url) await deleteOwnedAvatar(assets, org.id, org[kind.column])

      return c.json({ ok: true, [kind.column]: url })
    })

    app.delete(`/api/accounts/:owner/${kind.path}`, async (c) => {
      const org = await ownedOrg(c, kind.noun)
      if (org instanceof Response) return org
      const assets = assetsOr503(c)
      if (assets instanceof Response) return assets

      await c.var.ports.db
        .update(schema.organization)
        .set({ [kind.column]: null })
        .where(eq(schema.organization.id, org.id))
      await deleteOwnedAvatar(assets, org.id, org[kind.column])

      return c.json({ ok: true })
    })
  }

  return app
}
