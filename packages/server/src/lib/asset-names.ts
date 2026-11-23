/**
 * The bytes a collection holds (PDFs, images) are "assets" (`ul:asset:<hex>`, `$asset`), but
 * the API first named them files. Responses carry both names with the same value, and routes
 * answer at both paths, so integrations and installed CLIs built on the old names keep working.
 */

/** Each old field name a response may carry, and the asset name sent beside it. */
const ASSET_NAMES: Record<string, string> = {
  fileCount: 'assetCount',
  publicFileCount: 'publicAssetCount',
  filesNeeded: 'assetsNeeded',
}

/**
 * A stored body (a push or upload result, a refusal) with each asset name beside its old
 * one: bodies stored before the asset names were added lack them. Anything else as it is.
 */
export function withAssetNames<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    out[k] = v
    const alias = ASSET_NAMES[k]
    if (alias && !(alias in body)) out[alias] = v
  }
  return out as T
}

/**
 * Routes registered at both their asset path and their old files path: `segment` is
 * `assets` or `files`. One handler serves both.
 */
export const ASSET_SEGMENTS = ['files', 'assets'] as const

/**
 * A manifest's asset list (protocol-v2 11.3.6: on the first page only), cut at `max`, as
 * `files` and as `assets`.
 */
export function assetList(hashes: string[], max: number) {
  const listed = hashes.slice(0, max)
  return hashes.length > max
    ? { files: listed, assets: listed, filesTruncated: true, assetsTruncated: true }
    : { files: listed, assets: listed }
}
