/**
 * Links in record data (docs/protocol-v3.md, Section 2.2).
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
 * v2's file reference, `{"$file": "sha256:<hex>"}`, is read as a link to `ul:file:<hex>`
 * by `links`, so that records written before `$link` keep their meaning. It is not
 * checked: as in v2, a `$file` with any other value is not a reference.
 */
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
  /** Set when it was written as v2's `{"$file": "sha256:<hex>"}`. */
  file?: true
}

const COLLECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FILE_REF = /^sha256:([0-9a-f]{64})$/
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
    return 'is bare hex: write ul:rec:<hex>, ul:file:<hex> or ul:ver:<hex>'
  if (/^ulv3:[0-9a-f]{64}$/.test(s)) return 'is a ulv3: id: write ul:ver:<hex>'
  if (/^sha256:[0-9a-f]{64}$/.test(s)) return 'is a sha256: hash: write ul:file:<hex>'
  if (/^ul:/i.test(s) && parseUlId(s.toLowerCase())) return 'must be lowercase'
  return 'must be ul:rec:<hex>, ul:file:<hex> or ul:ver:<hex>, with 64 lowercase hex digits'
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
 * if every link is well formed. A server refuses a record with one.
 */
export function checkLinks(data: unknown): string | null {
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
      const place = placeProblem(v)
      return place ? `$link at ${at()}: ${place}` : null
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
 * Every link in a record's data, in document order, with `$file` references read as file
 * links. A malformed `$link` is skipped (a server has refused it before it is stored).
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
    if (typeof v.$file === 'string') {
      const m = FILE_REF.exec(v.$file)
      if (m) {
        out.push({ kind: 'file', hash: m[1]!, path, file: true })
        return
      }
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
