/**
 * Org logos and covers: shown at the size the page needs (the server's /img route,
 * api/images.ts), and shrunk in the browser before they're uploaded.
 */
import { useAppContext } from '~/lib/app-context'

/** The server's IMAGE_WIDTHS (api/images.ts): /img makes these widths only. */
export const IMAGE_WIDTHS = [64, 128, 256, 640, 1280, 1920, 2560] as const
type Width = (typeof IMAGE_WIDTHS)[number]

/**
 * `src`, `srcSet` and `sizes` for an image, through /img when it's in this deployment's
 * public assets bucket; any other URL (a migrated logo on another host) as it is.
 */
export function sizedImage(
  url: string,
  assetsBaseUrl: string | null | undefined,
  widths: readonly Width[],
  sizes: string,
): { src: string; srcSet?: string; sizes?: string } {
  const prefix = assetsBaseUrl ? `${assetsBaseUrl}/` : null
  if (!prefix || !url.startsWith(`${prefix}avatars/`)) return { src: url }
  const key = url.slice(prefix.length)
  const at = (w: number) => `/img/${w}/${key}`
  return {
    src: at(widths[widths.length - 1]!),
    srcSet: widths.map((w) => `${at(w)} ${w}w`).join(', '),
    sizes,
  }
}

/** sizedImage with this deployment's assets URL. */
export function useSizedImage(url: string, widths: readonly Width[], sizes: string) {
  const { assetsBaseUrl } = useAppContext() ?? {}
  return sizedImage(url, assetsBaseUrl, widths, sizes)
}

/**
 * The file to upload: a large JPEG, PNG or WebP scaled to `maxWidth` and re-encoded as
 * WebP, which keeps transparency. GIFs (perhaps animated), images already small
 * enough, and anything the browser can't decode go as they are, as does a result
 * that came out no smaller.
 */
export async function shrinkImage(file: File, maxWidth: number, maxBytes = 400 * 1024) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== 'function')
    return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }
  try {
    if (bitmap.width <= maxWidth && file.size <= maxBytes) return file
    const scale = Math.min(1, maxWidth / bitmap.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.85),
    )
    // Browsers that can't encode WebP hand back a PNG instead.
    if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' })
  } finally {
    bitmap.close()
  }
}
