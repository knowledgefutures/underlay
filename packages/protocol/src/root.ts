/**
 * Version roots, set objects and the private-set commitment.
 *
 *   root = {"underlay":2,"metadata":{…}|null,"public":SetObject,"private":commitment|null}
 *   SetObject = {"types":{slug:{"schema","root","count","bytes"}},"files":{"root","count","bytes"}}
 *   private set object = SetObject + {"salt": 64 hex}
 *   commitment = sha256(JCS(private set object))
 *   version hash = "ulv2:" + sha256(JCS(root))
 */
import { PROTOCOL_VERSION, VERSION_HASH_PREFIX } from './constants.js'
import { sha256Hex } from './hash.js'
import { checkTypeSlug } from './input-rules.js'
import { jcs } from './jcs.js'

export interface TreeSummary {
  root: string | null
  count: number
  bytes: number
}

export interface TypeEntry extends TreeSummary {
  schema: string
}

export interface SetObject {
  types: Record<string, TypeEntry>
  files: TreeSummary
}

export interface PrivateSetObject extends SetObject {
  salt: string
}

export interface VersionRoot {
  underlay: typeof PROTOCOL_VERSION
  metadata: Record<string, unknown> | null
  public: SetObject
  private: string | null
}

export const EMPTY_TREE: TreeSummary = Object.freeze({ root: null, count: 0, bytes: 0 })

export function emptySet(): SetObject {
  return { types: {}, files: { ...EMPTY_TREE } }
}

/** A private set is empty when it has no types and no files; its commitment is then null. */
export function isEmptySet(s: SetObject): boolean {
  return Object.keys(s.types).length === 0 && s.files.count === 0
}

/**
 * The protocol versions this package reads, checked against `underlay` in every
 * root it loads. v1 hashes are computed for migration, but v1 never had
 * repositories to read.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [2]

/** A root written in a protocol version this package can't read. */
export class UnsupportedProtocolError extends Error {
  constructor(readonly version: unknown) {
    super(
      `Underlay protocol version ${JSON.stringify(version)} is not supported (this package reads ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
    )
    this.name = 'UnsupportedProtocolError'
  }
}

/** Throw unless a root's `underlay` version is one this package reads. */
export function checkProtocolVersion(root: { underlay?: unknown }): void {
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(root.underlay as number)) {
    throw new UnsupportedProtocolError(root.underlay)
  }
}

/** 32 random bytes as hex: one per collection, reused across its versions. */
export function newSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function privateCommitment(p: PrivateSetObject): string {
  return sha256Hex(jcs(p))
}

export function makeRoot(
  metadata: Record<string, unknown> | null,
  pub: SetObject,
  priv: PrivateSetObject | null,
): VersionRoot {
  return {
    underlay: PROTOCOL_VERSION,
    metadata,
    public: pub,
    private: priv && !isEmptySet(priv) ? privateCommitment(priv) : null,
  }
}

export function encodeRoot(root: VersionRoot): string {
  return jcs(root)
}

export function versionHash(root: VersionRoot): string {
  return VERSION_HASH_PREFIX + sha256Hex(encodeRoot(root))
}

/** The bare hex digest of a `ulv2:` version hash (the object key under roots/). */
export function versionDigest(hash: string): string {
  if (!hash.startsWith(VERSION_HASH_PREFIX)) {
    // `ulv<n>:` names another protocol version: say so rather than "malformed".
    const other = /^ulv(\d+):/.exec(hash)
    if (other) throw new UnsupportedProtocolError(Number(other[1]))
    throw new Error(`Not a v2 version hash: ${hash}`)
  }
  return hash.slice(VERSION_HASH_PREFIX.length)
}

/** Totals over every type tree of a set (records only). */
export function setRecordTotals(s: SetObject): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const t of Object.values(s.types)) {
    count += t.count
    bytes += t.bytes
  }
  return { count, bytes }
}

const HEX64 = /^[0-9a-f]{64}$/

function checkSummary(t: unknown, where: string): string | null {
  const s = t as TreeSummary
  if (!s || typeof s !== 'object') return `${where}: not an object`
  if (s.root !== null && (typeof s.root !== 'string' || !HEX64.test(s.root)))
    return `${where}: bad root`
  if (!Number.isSafeInteger(s.count) || s.count < 0) return `${where}: bad count`
  if (!Number.isSafeInteger(s.bytes) || s.bytes < 0) return `${where}: bad bytes`
  if ((s.root === null) !== (s.count === 0)) return `${where}: root and count disagree`
  if (s.root === null && s.bytes !== 0) return `${where}: root and bytes disagree`
  return null
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** Shape check for a set object read from storage or a peer. Returns an error or null. */
export function checkSetObject(s: unknown, isPrivate = false): string | null {
  const set = s as PrivateSetObject
  if (!isPlainObject(set) || !isPlainObject(set.types)) return 'set: bad types'
  const expected = isPrivate ? 3 : 2
  if (Object.keys(set).length !== expected) return 'set: unexpected fields'
  if (isPrivate && (typeof set.salt !== 'string' || !HEX64.test(set.salt))) return 'set: bad salt'
  for (const [slug, t] of Object.entries(set.types)) {
    const slugError = checkTypeSlug(slug)
    if (slugError) return `type ${JSON.stringify(slug)}: ${slugError}`
    const e = checkSummary(t, `type ${slug}`)
    if (e) return e
    if (typeof t.schema !== 'string' || !HEX64.test(t.schema))
      return `type ${slug}: bad schema hash`
    if (Object.keys(t).length !== 4) return `type ${slug}: unexpected fields`
  }
  const e = checkSummary(set.files, 'files')
  if (e) return e
  if (Object.keys(set.files).length !== 3) return 'files: unexpected fields'
  return null
}

const ROOT_MEMBERS = ['underlay', 'metadata', 'public', 'private']

/**
 * Shape check for a version root from a peer (section 10): exactly its four
 * members, this protocol version, metadata an object or null, a valid public
 * set, and a commitment or null. Returns an error or null.
 */
export function checkVersionRoot(r: unknown): string | null {
  if (!isPlainObject(r)) return 'root: not an object'
  if (Object.keys(r).length !== 4 || !ROOT_MEMBERS.every((k) => Object.hasOwn(r, k)))
    return 'root: unexpected fields'
  if (r.underlay !== PROTOCOL_VERSION) return 'root: bad protocol version'
  if (r.metadata !== null && !isPlainObject(r.metadata))
    return 'root: metadata must be an object or null'
  if (r.private !== null && (typeof r.private !== 'string' || !HEX64.test(r.private)))
    return 'root: bad private commitment'
  const e = checkSetObject(r.public)
  return e ? `public ${e}` : null
}

/**
 * Shape check for a private set object: a root names one only for a non-empty
 * private set (section 10). Returns an error or null.
 */
export function checkPrivateSetObject(s: unknown): string | null {
  return checkSetObject(s, true) ?? (isEmptySet(s as SetObject) ? 'set: empty' : null)
}
