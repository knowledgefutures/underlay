/**
 * Org logos in the deployment's public assets bucket: what an upload may be,
 * and which stored objects this deployment may delete.
 *
 * Objects are content-addressed (`avatars/<orgId>/<sha256>.<ext>`) and immutable.
 * A logo is deleted only when it's in this deployment's bucket: a URL under
 * ASSETS_BASE_URL and the org's own folder. Migrated URLs on another host
 * (staging's v1 links into production's bucket) are never touched.
 */
import { listAll } from '@underlay/protocol'

import type { PublicAssets } from '../ports.js'

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

/** The org's folder in the bucket. */
export const avatarFolder = (orgId: string) => `avatars/${orgId}/`

/**
 * Delete a logo this deployment stored for this org. Anything else (another
 * host, another org's folder, an unexpected key) is left alone. Non-fatal: an
 * orphaned logo is harmless, so storage errors are logged, not thrown.
 */
export async function deleteOwnedAvatar(
  assets: PublicAssets,
  orgId: string,
  url: string | null,
): Promise<void> {
  const folder = `${assets.baseUrl}/${avatarFolder(orgId)}`
  if (!url?.startsWith(folder)) return
  const name = url.slice(folder.length)
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name)) return
  try {
    await assets.store.delete(avatarFolder(orgId) + name)
  } catch (err) {
    console.error(`[avatars] Failed to delete ${url}:`, err)
  }
}

/**
 * Delete every logo under the org's folder in this deployment's bucket, as v1
 * did when an org or account was deleted. Non-fatal, as above.
 */
export async function deleteOrgAvatars(
  assets: PublicAssets | undefined,
  orgId: string,
): Promise<void> {
  if (!assets) return
  try {
    for await (const key of listAll(assets.store, avatarFolder(orgId))) {
      await assets.store.delete(key)
    }
  } catch (err) {
    console.error(`[avatars] Failed to delete logos of org ${orgId}:`, err)
  }
}
