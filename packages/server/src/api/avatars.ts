/**
 * Org logos, stored in the deployment's public assets bucket and linked from
 * `organization.avatar_url` as an absolute URL (as v1 did).
 *
 *   POST   /api/accounts/:owner/avatar    multipart/form-data, one image file
 *   DELETE /api/accounts/:owner/avatar
 *
 * Owners of the org only, as in v1; read-only and collection-scoped keys can't.
 * Objects are content-addressed (`avatars/<orgId>/<sha256>.<ext>`) and immutable.
 * An old logo is deleted only when its URL is under this deployment's
 * ASSETS_BASE_URL and the org's own folder: migrated URLs on another host
 * (staging's v1 links into production's bucket) are never touched.
 */
import { and, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import type { PublicAssets } from '../ports.js'
import { jsonError } from './access.js'
import { BodyTooLarge, readBytes } from './body.js'

/** Logos show at a couple of hundred pixels; GitHub caps profile pictures at 1 MB too. */
export const AVATAR_MAX_BYTES = 1024 * 1024
/** Multipart framing around the file. */
const MULTIPART_OVERHEAD = 64 * 1024
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

/**
 * The raster format of an image by its magic bytes, or null. SVG is never one:
 * the assets domain is underlay.org's, and an SVG there could run script.
 */
export function sniffRaster(b: Uint8Array): { type: string; ext: string } | null {
  const at = (offset: number, bytes: number[]) => bytes.every((v, i) => b[offset + i] === v)
  const ascii = (offset: number, s: string) =>
    at(
      offset,
      [...s].map((ch) => ch.charCodeAt(0)),
    )
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { type: 'image/png', ext: 'png' }
  if (at(0, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg', ext: 'jpg' }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { type: 'image/gif', ext: 'gif' }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { type: 'image/webp', ext: 'webp' }
  return null
}

type Org = typeof schema.organization.$inferSelect

/** The org, when the caller owns it; otherwise the error response. */
async function ownedOrg(c: Context<AppEnv>): Promise<Org | Response> {
  const { db } = c.var.ports
  const p = c.var.principal
  if (!p) return jsonError(c, 401, 'Authentication required')
  const [org] = await db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.slug, c.req.param('owner') ?? ''))
    .limit(1)
  if (!org) return jsonError(c, 404, 'Organization not found')

  let role: string | null = null
  if (!p.collectionIds && p.scope !== 'read') {
    // An org-owned key acts with its org's authority, and no other's.
    if (p.orgId) role = p.orgId === org.id ? 'owner' : null
    else {
      const [m] = await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, p.userId)))
        .limit(1)
      role = m?.role ?? null
    }
  }
  if (role !== 'owner')
    return jsonError(c, 403, 'Must be an owner to update the organization avatar')
  return org
}

function assetsOr503(c: Context<AppEnv>): PublicAssets | Response {
  return (
    c.var.ports.publicAssets ??
    jsonError(c, 503, 'Avatar uploads are not configured on this deployment')
  )
}

/**
 * Delete a logo this deployment stored for this org. Anything else (another
 * host, another org's folder, an unexpected key) is left alone. Non-fatal: an
 * orphaned logo is harmless, so storage errors are logged, not thrown.
 */
async function deleteOwnedAvatar(assets: PublicAssets, orgId: string, url: string | null) {
  const folder = `${assets.baseUrl}/avatars/${orgId}/`
  if (!url?.startsWith(folder)) return
  const name = url.slice(folder.length)
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name)) return
  try {
    await assets.store.delete(`avatars/${orgId}/${name}`)
  } catch (err) {
    console.error(`[avatars] Failed to delete ${url}:`, err)
  }
}

export function avatarRoutes() {
  const app = new Hono<AppEnv>()

  app.post('/api/accounts/:owner/avatar', async (c) => {
    const org = await ownedOrg(c)
    if (org instanceof Response) return org
    const assets = assetsOr503(c)
    if (assets instanceof Response) return assets

    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.startsWith('multipart/form-data'))
      return jsonError(c, 400, 'Send the image as multipart/form-data')
    let form: FormData
    try {
      const body = await readBytes(c, AVATAR_MAX_BYTES + MULTIPART_OVERHEAD)
      form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
    } catch (err) {
      if (err instanceof BodyTooLarge)
        return jsonError(c, 413, `Image must be ${AVATAR_MAX_BYTES / 1024 / 1024} MB or smaller`)
      return jsonError(c, 400, 'Malformed multipart body')
    }
    const file = [...form.values()].find((v): v is File => typeof v !== 'string')
    if (!file) return jsonError(c, 400, 'No file uploaded')
    if (file.size > AVATAR_MAX_BYTES)
      return jsonError(c, 413, `Image must be ${AVATAR_MAX_BYTES / 1024 / 1024} MB or smaller`)

    // The declared type is the browser's guess from the file name; the bytes decide.
    const bytes = new Uint8Array(await file.arrayBuffer())
    const raster = sniffRaster(bytes)
    if (!ALLOWED_TYPES.includes(file.type) || !raster)
      return jsonError(c, 422, 'Only JPEG, PNG, GIF, and WebP images are allowed')

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const hash = [...digest].map((v) => v.toString(16).padStart(2, '0')).join('')
    const key = `avatars/${org.id}/${hash}.${raster.ext}`
    await assets.store.put(key, bytes, { contentType: raster.type, cacheControl: CACHE_CONTROL })

    const avatarUrl = `${assets.baseUrl}/${key}`
    await c.var.ports.db
      .update(schema.organization)
      .set({ avatarUrl })
      .where(eq(schema.organization.id, org.id))
    if (org.avatarUrl !== avatarUrl) await deleteOwnedAvatar(assets, org.id, org.avatarUrl)

    return c.json({ ok: true, avatarUrl })
  })

  app.delete('/api/accounts/:owner/avatar', async (c) => {
    const org = await ownedOrg(c)
    if (org instanceof Response) return org
    const assets = assetsOr503(c)
    if (assets instanceof Response) return assets

    await c.var.ports.db
      .update(schema.organization)
      .set({ avatarUrl: null })
      .where(eq(schema.organization.id, org.id))
    await deleteOwnedAvatar(assets, org.id, org.avatarUrl)

    return c.json({ ok: true })
  })

  return app
}
