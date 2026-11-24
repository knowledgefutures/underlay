/**
 * Asset references in record data (docs/protocol/v3.md, Section 5.3).
 *
 * A record attaches an asset with an object, at any depth of its `data`, whose `$asset`
 * member is the asset's Underlay id. Two other members have a meaning: `mediaType`, what the
 * bytes are (an IANA media type), and `fileName`, what to call them when saved. Any other
 * member is the publisher's. The walk doesn't descend into a reference.
 *
 *   {"$asset": "ul:asset:<hex>", "mediaType": "image/png", "fileName": "cover.png"}
 *
 * A malformed `$asset` is refused at push (`checkLinks`, links.ts), and so is a `$file`, how
 * drafts attached assets before (v2's own `$file` is read by `fileRefs`, file-refs.ts).
 */

export const ASSET_MEMBER = '$asset'
/** What an attached asset's bytes are: an IANA media type, `type/subtype`. */
export const MEDIA_TYPE_MEMBER = 'mediaType'
/** What to call an attached asset when it's saved: a file name, no directories. */
export const FILE_NAME_MEMBER = 'fileName'

// RFC 6838 restricted names, then optional parameters in printable ASCII (RFC 9110 8.3.1:
// a media type is sent as a header, which takes no other characters).
const MEDIA_TYPE =
  /^([a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126})((?:[ \t]*;[\x20-\x7e]*)?)$/i

/**
 * A media type as an asset reference may declare it, or null when it isn't one. Type and
 * subtype are case-insensitive (RFC 6838 4.2), so they come back lowercase.
 */
export function mediaTypeOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  const m = t.length <= 255 ? MEDIA_TYPE.exec(t) : null
  return m ? m[1]!.toLowerCase() + m[2]! : null
}

/**
 * Characters a file name may not hold: path separators, control characters (C0, DEL, C1), and
 * the invisible formatting characters that can make a name read as another (bidirectional
 * overrides and isolates, line and paragraph separators, a byte order mark).
 */
const NOT_IN_NAME =
  // eslint-disable-next-line no-control-regex
  /[/\\\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/

/**
 * A file name as an asset reference may declare it, or null: no directories, no control or
 * bidirectional formatting characters, at most 255 characters.
 */
export function fileNameOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const n = v.trim()
  return n && n.length <= 255 && !NOT_IN_NAME.test(n) && n !== '.' && n !== '..' ? n : null
}

const ASSET_ID = /^ul:asset:([0-9a-f]{64})$/

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
  return null
}

/** Whether a record's text may hold an asset reference: a cheap test before parsing it. */
export const mayHoldAssetRefs = (text: string) => text.includes('"$asset"')

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

/**
 * The media types a record's data declares for the assets it attaches, by hash (bare hex). A
 * reference without a well-formed `mediaType` declares none; when two references to one
 * asset disagree, the first wins.
 */
export function assetMediaTypes(data: unknown): Record<string, string> {
  const out: Record<string, string> = {}
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
      const type = mediaTypeOf(o[MEDIA_TYPE_MEMBER])
      if ('hash' in ref && type && !Object.hasOwn(out, ref.hash)) out[ref.hash] = type
      return
    }
    for (const k in o) walk(o[k])
  }
  walk(data)
  return out
}
