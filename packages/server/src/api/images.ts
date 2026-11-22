/**
 * Org logos and covers at the size a page shows them, so a 2600px PNG cover isn't
 * sent whole to every visitor.
 *
 *   GET /img/:width/avatars/<orgId>/<name>
 *
 * `width` is one of IMAGE_WIDTHS (the web app's lib/images.ts asks for these), and the
 * format follows the browser's Accept header: AVIF, else WebP, else the original's.
 * Images are never enlarged. Each size is made once with the Images binding, kept in
 * the public bucket beside the original (lib/avatars.ts sizedFolder) and in the cache,
 * so how many get made is bounded by images × widths × formats, not by traffic.
 *
 * GIFs (which may be animated), deployments without the binding, and a failed resize
 * redirect to the original. Nothing here reads the session: the route is mounted
 * before app.ts's request middleware, and the images are public.
 */
import { type Context, Hono } from 'hono'

import { sizedFolder } from '../lib/avatars.js'
import type { Ports, SizedFormat } from '../ports.js'

/** Widths /img makes. lib/images.ts in the web app picks from the same list. */
export const IMAGE_WIDTHS = [64, 128, 256, 640, 1280, 1920, 2560] as const

const IMMUTABLE = 'public, max-age=31536000, immutable'
const KEY = /^avatars\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.(png|jpg|gif|webp))$/
const TYPES: Record<SizedFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

/** The best format the browser takes; a JPEG stays JPEG and the rest PNG for those that take neither. */
export function sizedFormat(accept: string, ext: string): SizedFormat {
  if (/\bimage\/avif\b/.test(accept)) return 'avif'
  if (/\bimage\/webp\b/.test(accept)) return 'webp'
  return ext === 'jpg' ? 'jpeg' : 'png'
}

function image(bytes: Uint8Array, format: SizedFormat) {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': TYPES[format], 'cache-control': IMMUTABLE, vary: 'accept' },
  })
}

export function imageRoutes(portsOf: (c: Context) => Ports) {
  const app = new Hono()

  app.get('/img/:width/:key{.+}', async (c) => {
    const width = Number(c.req.param('width'))
    const match = KEY.exec(c.req.param('key'))
    if (!(IMAGE_WIDTHS as readonly number[]).includes(width) || !match)
      return c.json({ error: 'Not found', statusCode: 404 }, 404)
    const ports = portsOf(c)
    const assets = ports.publicAssets
    if (!assets) return c.json({ error: 'Not found', statusCode: 404 }, 404)
    const [key, orgId, name, ext] = match as unknown as [string, string, string, string]
    const original = () => c.redirect(`${assets.baseUrl}/${key}`, 302)
    if (ext === 'gif' || !ports.images) return original()

    const format = sizedFormat(c.req.header('accept') ?? '', ext)
    const sized = `${sizedFolder(orgId, name)}${width}.${format}`
    const cached = await ports.cache.get(`img/${sized}`)
    if (cached) return image(cached, format)

    const stored = await assets.store.get(sized)
    if (stored) {
      const bytes = await stored.bytes()
      await ports.cache.put(`img/${sized}`, bytes)
      return image(bytes, format)
    }

    const source = await assets.store.get(key)
    if (!source) return c.json({ error: 'Not found', statusCode: 404 }, 404)
    let bytes: Uint8Array
    try {
      bytes = await ports.images.resize(await source.bytes(), { width, format })
    } catch (err) {
      console.error(`[images] Failed to resize ${key} to ${width} ${format}:`, err)
      return original()
    }
    ports.waitUntil(
      assets.store.put(sized, bytes, { contentType: TYPES[format], cacheControl: IMMUTABLE }),
    )
    await ports.cache.put(`img/${sized}`, bytes)
    return image(bytes, format)
  })

  return app
}
