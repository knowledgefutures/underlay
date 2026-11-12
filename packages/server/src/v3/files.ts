/**
 * Files of a v3 collection: its assets (docs/protocol-v3.md, Section 1). An asset belongs
 * to a collection because a `$asset` row names it, whether or not a record references it;
 * its bytes are at `assets/<sha256>` in the v3 area, and its size and media type are in
 * the row. Nothing here reads v2's `files` table or `files/` keys, which v2's cleanup may
 * clear once only v3 collections use a file.
 *
 * Who may read one: anyone who may read the collection, for an asset any of its versions
 * named (as v2's public file set is cumulative), and members for bytes uploaded to it.
 */
import { v3 } from '@underlay/protocol'

import { presignDownloads, safeMimeType, uploadedFiles } from '../files/files.js'
import { deniedHashes } from '../lib/limits.js'
import type { Ports } from '../ports.js'
import { type AssetData, dataOf, headView } from './catalog.js'
import { assetKey } from './rules.js'

/** An asset's data from the newest version that named it, or null if none ever did. */
export async function assetData(
  ports: Ports,
  collectionId: string,
  hash: string,
  view?: v3.View | null,
): Promise<AssetData | null> {
  const store = ports.stores.v3
  const head = view === undefined ? await headView(store, collectionId) : view
  if (!head) return null
  const rows = await v3.history(store, head, v3.ASSET_TYPE, hash)
  const named = rows.find((r) => r.kind === 'r')
  if (!named) return null
  const at = v3.viewAt(head, named.commit)
  const rec = at && (await v3.getRecord(store, at, v3.ASSET_TYPE, hash))
  return rec?.line ? (dataOf(rec.line) as AssetData) : null
}

/** Which of these hashes the caller may read from the collection. */
export async function v3ReadableFiles(
  ports: Ports,
  collectionId: string,
  member: boolean,
  hashes: string[],
): Promise<Map<string, AssetData | null>> {
  const view = await headView(ports.stores.v3, collectionId)
  const out = new Map<string, AssetData | null>()
  const rest: string[] = []
  for (const h of hashes) {
    const data = await assetData(ports, collectionId, h, view)
    if (data) out.set(h, data)
    else rest.push(h)
  }
  if (member)
    for (const h of (await uploadedFiles(ports.db, collectionId, rest)).keys()) out.set(h, null)
  return out
}

/** Presigned download URLs for assets, from the v3 area; blocked files get none. */
export async function v3PresignDownloads(
  ports: Ports,
  files: Map<string, AssetData | null>,
  expiresIn: number,
): Promise<Map<string, string>> {
  const denied = await deniedHashes(ports.db)
  // Bytes uploaded but not committed yet are still where the upload put them.
  const uploaded = [...files].filter(([, d]) => d === null).map(([h]) => h)
  const out = await presignDownloads(ports, uploaded)
  for (const [hash, data] of files) {
    if (denied.has(hash) || !data) continue
    out.set(
      hash,
      await ports.stores.fileBytes.presigner.presignGet(ports.stores.v3BucketKey(assetKey(hash)), {
        expiresIn,
        disposition: `attachment; filename="${hash}"`,
        // As v2 does: a type a browser would render or run is served as bytes.
        ...(data.mediaType ? { contentType: safeMimeType(data.mediaType) } : {}),
      }),
    )
  }
  return out
}
