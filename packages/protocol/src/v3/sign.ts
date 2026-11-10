/**
 * The two signatures of a commit (docs/protocol-v3.md, Section 4.2).
 *
 * The author signs what they sent: the collection, the files, the base, and the
 * message. The server signs where it landed: the whole commit, with its number
 * and the commit before it. Neither covers the other's part, so a change that
 * loses the race for a number is committed at the next one with the author's
 * signature untouched.
 *
 * Ed25519, as v2 Section 11.1, with v2's key ids and signers (`repo/log.ts`).
 * Which keys a reader trusts is not the protocol's to say.
 */
import { jcs } from '../jcs.js'
import { keyIdOf, type PublicKeyInfo, type Signer } from '../repo/log.js'
import { utf8 } from '../utf8.js'

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

/** The bytes a signature covers: the JCS of the object without its `sig`. */
export function signedBytes(o: object): Uint8Array {
  const { sig: _sig, ...rest } = o as { sig?: unknown }
  return utf8(jcs(rest))
}

/** Sign an object that has `keyId` and `sig` members: sets both. */
export async function signObject<T extends { keyId: string | null; sig: string | null }>(
  o: T,
  signer: Signer,
): Promise<T> {
  const unsigned = { ...o, keyId: signer.keyId, sig: null }
  return { ...unsigned, sig: b64url(await signer.sign(signedBytes(unsigned))) }
}

/**
 * Does one of these keys sign the object? A key counts only under its own id,
 * so a key list can't file a stranger's key under a trusted id.
 */
export async function verifyObject(
  o: { keyId: string | null; sig: string | null },
  keys: PublicKeyInfo[],
): Promise<boolean> {
  if (o.keyId === null || o.sig === null) return false
  const k = keys.find((x) => x.id === o.keyId)
  if (!k || k.alg !== 'Ed25519' || keyIdOf(k.publicKey) !== k.id) return false
  let sig: Uint8Array
  try {
    sig = fromB64url(o.sig)
  } catch {
    return false
  }
  const pub = await crypto.subtle.importKey(
    'raw',
    fromB64url(k.publicKey) as Uint8Array<ArrayBuffer>,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    'Ed25519',
    pub,
    sig as Uint8Array<ArrayBuffer>,
    signedBytes(o) as Uint8Array<ArrayBuffer>,
  )
}

export type { PublicKeyInfo, Signer }
