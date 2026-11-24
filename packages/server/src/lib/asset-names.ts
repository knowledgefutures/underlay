/**
 * The bytes a collection holds (PDFs, images) are "assets" (`ul:asset:<hex>`, `$asset`). The
 * API first named them files, and a push or upload stored its result or refusal under those
 * names: such a body is answered under the asset names.
 */

/** Each old field name a stored body may carry, and its asset name. */
const ASSET_NAMES: Record<string, string> = {
  fileCount: 'assetCount',
  publicFileCount: 'publicAssetCount',
  filesNeeded: 'assetsNeeded',
}

/**
 * A stored body (a push or upload result, a refusal) with each old field under its asset
 * name, and only there. Anything else as it is.
 */
export function withAssetNames<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    const name = ASSET_NAMES[k]
    if (!name) out[k] = v
    else if (!(name in body)) out[name] = v
  }
  return out as T
}
