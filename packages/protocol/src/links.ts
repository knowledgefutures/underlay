/**
 * Links in record data (docs/protocol.md, Section 5.2).
 *
 * A link is an object, at any depth of a record's `data`, with a `$link` member whose
 * value is a `ul:` id. It may say where its target was found, with `collection` (a
 * collection id), `type` and `id`; any other member is the publisher's. A link object is
 * not searched for further links.
 *
 *   {"$link": "ul:rec:<hex>", "collection": "<collection id>", "type": "work", "id": "10.1234/abc"}
 *
 * A server refuses a record with a malformed link (`checkLinks`). It never checks that a
 * target exists or can be read: a link is a claim made by the record that holds it.
 *
 * An asset reference, `{"$asset": "ul:asset:<hex>"}` (asset-refs.ts, Section 5.3), attaches
 * the asset as well as pointing at it; `links` reads it, and the older
 * `{"$file": "sha256:<hex>"}`, as a link to `ul:asset:<hex>`. `checkLinks` refuses a malformed
 * `$asset` too. A `$file` is not checked: as in v2, one with any other value is no reference.
 */
import { assetRefIn } from './asset-refs.js'
import { isHex64, parseUlId, type UlKind } from './ids.js'

export const LINK_MEMBER = '$link'
/** The members a link may carry to say where its target was found. */
export const LINK_PLACE_MEMBERS = ['collection', 'type', 'id'] as const

export interface Link {
  kind: UlKind
  hash: string
  collection?: string
  type?: string
  id?: string
  /** Where the link object is in the record's data, as a JSON Pointer (RFC 6901). */
  path: string
  /** Set for an asset reference (`$asset`, or `$file` before it), which attaches the asset. */
  attached?: true
}

const COLLECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Longest `type` or `id` a link may carry, in UTF-16 code units. */
const MAX_PLACE_CHARS = 1024

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const pointer = (path: string, key: string | number) =>
  `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`

/** What is wrong with a `$link` value, written to help someone who pasted a hash. */
function linkValueProblem(v: unknown): string {
  if (typeof v !== 'string') return 'must be a string'
  const s: string = v
  if (/^[0-9a-f]{64}$/.test(s))
    return 'is bare hex: write ul:rec:<hex>, ul:asset:<hex>, or ul:ver:<hex>'
  if (/^ulv3:[0-9a-f]{64}$/.test(s)) return 'is a ulv3: id: write ul:ver:<hex>'
  if (/^sha256:[0-9a-f]{64}$/.test(s)) return 'is a sha256: hash: write ul:asset:<hex>'
  if (/^ul:/i.test(s) && parseUlId(s.toLowerCase())) return 'must be lowercase'
  return 'must be ul:rec:<hex>, ul:asset:<hex>, or ul:ver:<hex>, with 64 lowercase hex digits'
}

/** What is wrong with a `$asset` value. */
function assetValueProblem(v: unknown): string {
  if (typeof v !== 'string') return 'must be a string'
  if (/^[0-9a-f]{64}$/.test(v)) return 'is bare hex: write ul:asset:<hex>'
  if (/^sha256:[0-9a-f]{64}$/.test(v)) return 'is a sha256: hash: write ul:asset:<hex>'
  if (/^ul:asset:[0-9a-f]{64}$/i.test(v)) return 'must be lowercase'
  const id = parseUlId(v.toLowerCase())
  if (id) return `names a ${id.kind === 'rec' ? 'record' : 'version'}: $asset takes ul:asset:<hex>`
  return 'must be ul:asset:<hex>, with 64 lowercase hex digits'
}

function placeProblem(o: Record<string, unknown>): string | null {
  if (
    o.collection !== undefined &&
    !(typeof o.collection === 'string' && COLLECTION_ID.test(o.collection))
  )
    return '"collection" must be a collection id'
  for (const k of ['type', 'id'] as const) {
    const v = o[k]
    if (v !== undefined && !(typeof v === 'string' && v.length > 0 && v.length <= MAX_PLACE_CHARS))
      return `"${k}" must be a string of 1 to ${MAX_PLACE_CHARS} characters`
  }
  return null
}

/**
 * The first malformed link in a record's data, as a message naming where it is, or null
 * if every link is well formed. A server refuses a record with one. A `$file` member, how
 * drafts attached assets before `$asset`, is refused too, so no new record carries it.
 */
export function checkLinks(
  data: unknown,
  /** `legacyFiles`: accept `$file` (v2's way of attaching a file, which v2 still reads). */
  opts: { legacyFiles?: boolean } = {},
): string | null {
  // Keys down to where the walk is; joined into a path only for a problem, since building a
  // path at every node cost ten times the walk itself (2026-11-23, a 4 KB record).
  const keys: (string | number)[] = []
  const at = () => keys.reduce<string>((p, k) => pointer(p, k), '') || '/'
  const walk = (v: unknown): string | null => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        keys.push(i)
        const p = walk(v[i])
        keys.pop()
        if (p) return p
      }
      return null
    }
    if (!isObject(v)) return null
    if (Object.hasOwn(v, LINK_MEMBER)) {
      if (!parseUlId(v[LINK_MEMBER])) return `$link at ${at()} ${linkValueProblem(v[LINK_MEMBER])}`
      if (Object.hasOwn(v, '$asset'))
        return `$link at ${at()} also holds $asset: a link points at an asset, $asset attaches it`
      const place = placeProblem(v)
      return place ? `$link at ${at()}: ${place}` : null
    }
    if (Object.hasOwn(v, '$asset')) {
      const ref = assetRefIn(v)
      return ref && 'bad' in ref ? `$asset at ${at()} ${assetValueProblem(ref.bad)}` : null
    }
    if (!opts.legacyFiles && Object.hasOwn(v, '$file')) {
      return `$file at ${at()} is not read: attach an asset with {"$asset": "ul:asset:<hex>"}`
    }
    for (const k in v) {
      keys.push(k)
      const p = walk(v[k])
      keys.pop()
      if (p) return p
    }
    return null
  }
  return walk(data)
}

/**
 * Every link in a record's data, in document order, with asset references (`$asset`) read
 * as asset links. A malformed `$link` or `$asset` is skipped (a
 * server has refused it before it is stored).
 */
export function links(data: unknown): Link[] {
  const out: Link[] = []
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, pointer(path, i)))
      return
    }
    if (!isObject(v)) return
    if (Object.hasOwn(v, LINK_MEMBER)) {
      const id = parseUlId(v[LINK_MEMBER])
      if (id && !placeProblem(v)) {
        const link: Link = { ...id, path }
        for (const k of LINK_PLACE_MEMBERS) if (typeof v[k] === 'string') link[k] = v[k]
        out.push(link)
      }
      return
    }
    const ref = assetRefIn(v)
    if (ref) {
      if ('hash' in ref) out.push({ kind: 'asset', hash: ref.hash, path, attached: true })
      return
    }
    for (const k in v) walk(v[k], pointer(path, k))
  }
  walk(data, '')
  return out
}

/** A link object for a target, with where it was found if given. */
export function makeLink(
  kind: UlKind,
  hash: string,
  place: { collection?: string; type?: string; id?: string } = {},
): Record<string, string> {
  if (!isHex64(hash)) throw new Error(`Not a SHA-256 in lowercase hex: ${JSON.stringify(hash)}`)
  const link: Record<string, string> = { [LINK_MEMBER]: `ul:${kind}:${hash}` }
  for (const k of LINK_PLACE_MEMBERS) if (place[k] !== undefined) link[k] = place[k]!
  const problem = placeProblem(link)
  if (problem) throw new Error(problem)
  return link
}
