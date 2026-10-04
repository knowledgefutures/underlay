/**
 * Synchronous SHA-256 everywhere the package runs. Node and Workers (with
 * nodejs_compat) expose their native hash through `process.getBuiltinModule`,
 * with no `node:` import for bundlers to trip on; browsers fall back to
 * @noble/hashes, about 6× slower on large inputs (edge-redesign-build.md,
 * "Package layout review"). The tree builder hashes every key and node, so it
 * can't use the async WebCrypto digest.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'

import { utf8 } from './utf8.js'

interface NodeHash {
  update(data: string | Uint8Array): NodeHash
  digest(): Uint8Array
  digest(encoding: 'hex'): string
}
type GetBuiltin = (id: 'node:crypto') => { createHash(algorithm: 'sha256'): NodeHash } | undefined

const getBuiltin = (globalThis as { process?: { getBuiltinModule?: GetBuiltin } }).process
  ?.getBuiltinModule
const native = getBuiltin?.('node:crypto')

const toBytes = (input: string | Uint8Array) => (typeof input === 'string' ? utf8(input) : input)

/** The fallback, exported for the test that it matches the native hash. */
export const portableSha256 = (input: string | Uint8Array) => nobleSha256(toBytes(input))
export function portableSha256Hex(input: string | Uint8Array): string {
  let out = ''
  for (const b of portableSha256(input)) out += b.toString(16).padStart(2, '0')
  return out
}

/** SHA-256 of a string (as UTF-8) or bytes. */
export function sha256(input: string | Uint8Array): Uint8Array {
  return native ? native.createHash('sha256').update(input).digest() : portableSha256(input)
}

/** Lowercase hex SHA-256 of a string (as UTF-8) or bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return native ? native.createHash('sha256').update(input).digest('hex') : portableSha256Hex(input)
}

/** Whether hashing is native (Node, Workers) or the portable fallback (browsers). */
export const nativeSha256 = native !== undefined
