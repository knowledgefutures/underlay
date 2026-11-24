/**
 * Underlay ids (docs/protocol.md, Section 5.1): how a record, an asset, or a version is
 * named by its hash outside the protocol's own objects, in record data, URLs, API
 * responses and citations.
 *
 *   ul:rec:<hex>     a record: the SHA-256 of its line (schemas are `$schema` records)
 *   ul:asset:<hex>   an asset: the SHA-256 of its bytes
 *   ul:ver:<hex>     a version: the SHA-256 of its commit
 *
 * Inside a commit, layout or file entry a hash is bare hex: the member it sits in says
 * what it is, so no display spelling ends up in hashed bytes.
 */

export const UL_KINDS = ['rec', 'asset', 'ver'] as const
export type UlKind = (typeof UL_KINDS)[number]

export interface UlId {
  kind: UlKind
  /** 64 lowercase hex characters. */
  hash: string
}

const HEX64 = /^[0-9a-f]{64}$/
const UL_ID = /^ul:(rec|asset|ver):([0-9a-f]{64})$/

/** Whether a value is a SHA-256 in lowercase hex: how protocol objects hold a hash. */
export const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v)

/** The `ul:` id of a hash. */
export function ulId(kind: UlKind, hash: string): string {
  if (!UL_KINDS.includes(kind)) throw new Error(`Unknown kind of Underlay id: ${kind}`)
  if (!HEX64.test(hash)) throw new Error(`Not a SHA-256 in lowercase hex: ${JSON.stringify(hash)}`)
  return `ul:${kind}:${hash}`
}

/** A `ul:` id taken apart, or null. Exact: lowercase, no spaces, no other spelling. */
export function parseUlId(v: unknown): UlId | null {
  if (typeof v !== 'string') return null
  const m = UL_ID.exec(v)
  return m ? { kind: m[1] as UlKind, hash: m[2]! } : null
}

/** Whether a value is a `ul:` id, of one kind if `kind` is given. */
export function isUlId(v: unknown, kind?: UlKind): v is string {
  const id = parseUlId(v)
  return id !== null && (kind === undefined || id.kind === kind)
}

/**
 * A hash as a person or another system may give it: what it names, and how it was written.
 * `kind` is null for bare hex, which doesn't say.
 */
export interface HashInput {
  hash: string
  kind: UlKind | null
  /**
   * How it was written, when not as a `ul:` id: `hex` for bare hex, `ulv2` for a v2
   * version hash (v2's own id, until v2 is retired), which names a converted version by its
   * old root and so is not the v3 commit's hash.
   */
  form: 'ul' | 'hex' | 'ulv2'
}

const V2_VERSION = /^ulv2:([0-9a-f]{64})$/

/**
 * Read a hash as a person may type or paste it: a `ul:` id, bare hex, or a v2 `ulv2:`
 * version id. Spaces around it and capital letters are forgiven. Null if it is none of
 * these. For what goes in record data, use `parseUlId`, which is exact.
 */
export function parseHashInput(v: unknown): HashInput | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  const id = parseUlId(s)
  if (id) return { ...id, form: 'ul' }
  if (HEX64.test(s)) return { hash: s, kind: null, form: 'hex' }
  const m = V2_VERSION.exec(s)
  return m ? { hash: m[1]!, kind: 'ver', form: 'ulv2' } : null
}
