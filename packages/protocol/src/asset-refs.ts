/**
 * Asset references in record data (docs/protocol-v3.md, Section 2.3).
 *
 * A record attaches an asset with an object, at any depth of its `data`, whose `$asset`
 * member is the asset's Underlay id. Any other member is the publisher's (a file name, a
 * media type). The walk doesn't descend into a reference.
 *
 *   {"$asset": "ul:asset:<hex>", "fileName": "cover.png"}
 *
 * Records written before 2026-11-22 attach with `{"$file": "sha256:<hex>"}`, read the same
 * way. As in v2, a `$file` with any other value is not a reference and is searched like any
 * other object; a malformed `$asset` is refused at push (`checkLinks`, links.ts).
 */

export const ASSET_MEMBER = '$asset'
/** The member records used before `$asset`. */
export const LEGACY_FILE_MEMBER = '$file'

const ASSET_ID = /^ul:asset:([0-9a-f]{64})$/
const FILE_REF = /^sha256:([0-9a-f]{64})$/

/**
 * What an object is as an asset reference: the hash it attaches (`hash`), a `$asset` whose
 * value is malformed (`bad`, the value), or null when it is no reference and is searched on.
 */
export function assetRefIn(o: Record<string, unknown>): { hash: string } | { bad: unknown } | null {
  if (Object.hasOwn(o, ASSET_MEMBER)) {
    const v = o[ASSET_MEMBER]
    const m = typeof v === 'string' ? ASSET_ID.exec(v) : null
    return m ? { hash: m[1]! } : { bad: v }
  }
  const f = typeof o[LEGACY_FILE_MEMBER] === 'string' ? FILE_REF.exec(o.$file as string) : null
  return f ? { hash: f[1]! } : null
}

/** Whether a record's text may hold an asset reference: a cheap test before parsing it. */
export const mayHoldAssetRefs = (text: string) =>
  text.includes('"$asset"') || text.includes('"$file"')

/**
 * The assets a record's data attaches, as bare hex, deduplicated, in first-seen order. A
 * `$link` object is a link, not searched.
 */
export function assetRefs(data: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    const o = v as Record<string, unknown>
    if (Object.hasOwn(o, '$link')) return
    const ref = assetRefIn(o)
    if (ref) {
      if ('hash' in ref) out.add(ref.hash)
      return
    }
    for (const k in o) walk(o[k])
  }
  walk(data)
  return [...out]
}
