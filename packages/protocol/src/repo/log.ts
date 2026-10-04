/**
 * The per-collection version log: one signed, hash-chained entry per version.
 *
 * It lets anyone holding a copy (a mirror, a restore, a frontend) check the
 * version history without the platform database, and it is the per-collection
 * head log from the plan's Security notes: entries chain by `prev`, so a server
 * can't silently drop or reorder versions for one reader and not another.
 *
 *   entry     = {seq, semver, versionHash, baseSemver, message, appId, actorId,
 *                createdAt, prev, keyId, sig}
 *   signed    = JCS(entry without "sig"), Ed25519, "sig" = base64url
 *   entryHash = sha256(JCS(entry))          (with "sig")
 *   prev      = entryHash of seq − 1, or null for seq 1
 *   head.json = {"seq", "entryHash", "versionHash"}, overwritten after the entry is written
 *
 * Pusher identity is omitted from the log (an open question in the plan).
 */
import { jcs, sha256Hex } from '../format.js'
import { IntegrityError, keys, type Repo } from './repo.js'

export interface LogEntry {
  seq: number
  semver: string
  versionHash: string
  baseSemver: string | null
  message: string | null
  appId: string | null
  actorId: string | null
  /** ISO 8601, UTC. */
  createdAt: string
  prev: string | null
  keyId: string
  sig: string
}

export type UnsignedEntry = Omit<LogEntry, 'keyId' | 'sig'>

export interface Head {
  seq: number
  entryHash: string
  versionHash: string
}

export interface CollectionInfo {
  id: string
  owner: string
  slug: string
  name: string
  /** Public keys that sign this collection's log. */
  keys: PublicKeyInfo[]
  [k: string]: unknown
}

export interface PublicKeyInfo {
  id: string
  alg: 'Ed25519'
  /** Raw 32-byte public key, base64url. */
  publicKey: string
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const enc = new TextEncoder()

export const entryHash = (e: LogEntry) => sha256Hex(jcs(e))

/** The bytes that are signed: the entry without its signature. */
const signedBytes = (e: Omit<LogEntry, 'sig'>) => enc.encode(jcs(e))

export interface Signer {
  keyId: string
  publicKey: PublicKeyInfo
  sign(bytes: Uint8Array): Promise<Uint8Array>
}

/** A signer from a raw 32-byte Ed25519 private key (seed), base64url. */
export async function ed25519Signer(privateKeyB64: string): Promise<Signer> {
  // WebCrypto imports Ed25519 private keys as PKCS#8; wrap the seed.
  const seed = fromB64url(privateKeyB64)
  if (seed.length !== 32) throw new Error('Ed25519 private key must be 32 bytes')
  const pkcs8 = new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x04,
    0x22,
    0x04,
    0x20,
    ...seed,
  ])
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', key)
  const publicKey = fromB64url(jwk.x!)
  const id = sha256Hex(publicKey).slice(0, 16)
  return {
    keyId: id,
    publicKey: { id, alg: 'Ed25519', publicKey: b64url(publicKey) },
    sign: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes as Uint8Array<ArrayBuffer>)),
  }
}

/** Generate a new signing key; returns the private key seed (base64url) to store as a secret. */
export async function generateSigningKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return jwk.d!
}

export async function signEntry(signer: Signer, e: UnsignedEntry): Promise<LogEntry> {
  const unsigned = { ...e, keyId: signer.keyId }
  const sig = b64url(await signer.sign(signedBytes(unsigned)))
  return { ...unsigned, sig }
}

export async function verifyEntry(e: LogEntry, keys: PublicKeyInfo[]): Promise<boolean> {
  const k = keys.find((x) => x.id === e.keyId)
  if (!k || k.alg !== 'Ed25519') return false
  const pub = await crypto.subtle.importKey(
    'raw',
    fromB64url(k.publicKey) as Uint8Array<ArrayBuffer>,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  const { sig, ...unsigned } = e
  return crypto.subtle.verify(
    'Ed25519',
    pub,
    fromB64url(sig) as Uint8Array<ArrayBuffer>,
    signedBytes(unsigned) as Uint8Array<ArrayBuffer>,
  )
}

// --- Reading and writing the log in a repository ---

const dec = new TextDecoder()

async function readJson<T>(repo: Repo, key: string): Promise<T | null> {
  const obj = await repo.blobs.get(key)
  return obj ? (JSON.parse(dec.decode(await obj.bytes())) as T) : null
}

export const readHead = (repo: Repo, collectionId: string) =>
  readJson<Head>(repo, keys.head(collectionId))
export const readCollectionInfo = (repo: Repo, collectionId: string) =>
  readJson<CollectionInfo>(repo, keys.collection(collectionId))
export const readLogEntry = (repo: Repo, collectionId: string, seq: number) =>
  readJson<LogEntry>(repo, keys.logEntry(collectionId, seq))

export async function writeCollectionInfo(repo: Repo, info: CollectionInfo): Promise<void> {
  await repo.blobs.put(keys.collection(info.id), JSON.stringify(info, null, 1), {
    contentType: 'application/json',
  })
}

/**
 * Append a log entry and then move the head. Call only after every object the
 * version reaches (nodes, bodies, root, private set) is written: a reader that
 * finds head.json can always read everything below it.
 */
export async function appendLog(repo: Repo, collectionId: string, entry: LogEntry): Promise<Head> {
  await repo.blobs.put(keys.logEntry(collectionId, entry.seq), jcs(entry), {
    contentType: 'application/json',
    ifAbsent: true,
  })
  const head: Head = { seq: entry.seq, entryHash: entryHash(entry), versionHash: entry.versionHash }
  await repo.blobs.put(keys.head(collectionId), jcs(head), { contentType: 'application/json' })
  return head
}

/**
 * Check log entries that continue a log: consecutive seqs from `after.seq + 1`
 * (or 1), each chaining to the previous entry's hash and signed by a trusted
 * key. Returns the new head. For mirrors and clients that already verified the
 * log up to `after`.
 */
export async function verifyLogEntries(
  entries: readonly LogEntry[],
  trustedKeys: PublicKeyInfo[],
  after: { seq: number; entryHash: string } | null,
): Promise<{ seq: number; entryHash: string } | null> {
  let seq = after?.seq ?? 0
  let prev = after?.entryHash ?? null
  for (const e of entries) {
    seq++
    if (e.seq !== seq) throw new IntegrityError(`Log entry ${seq} has seq ${e.seq}`)
    if (e.prev !== prev) throw new IntegrityError(`Log entry ${seq} does not chain to ${seq - 1}`)
    if (!(await verifyEntry(e, trustedKeys)))
      throw new IntegrityError(`Log entry ${seq} has a bad signature`)
    prev = entryHash(e)
  }
  return prev === null ? null : { seq, entryHash: prev }
}

/**
 * Check a collection's whole log: signatures, the hash chain, and that the head
 * matches the last entry. O(versions); for restore and audits.
 */
export async function verifyLog(
  repo: Repo,
  collectionId: string,
  trustedKeys: PublicKeyInfo[],
): Promise<{ head: Head; entries: LogEntry[] }> {
  const head = await readHead(repo, collectionId)
  if (!head) throw new IntegrityError(`Collection ${collectionId} has no head`)
  const entries: LogEntry[] = []
  for (let seq = 1; seq <= head.seq; seq++) {
    const e = await readLogEntry(repo, collectionId, seq)
    if (!e) throw new IntegrityError(`Log entry ${seq} is missing`)
    entries.push(e)
  }
  const last = await verifyLogEntries(entries, trustedKeys, null)
  if (last?.entryHash !== head.entryHash)
    throw new IntegrityError('head.json does not match the last log entry')
  return { head, entries }
}
