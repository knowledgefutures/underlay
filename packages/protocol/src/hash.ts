import { jcs } from './jcs.js'
import { sha256Hex } from './sha256.js'

export { sha256Hex }

/**
 * The canonical record: a fixed `{"id","type","data"}` envelope with only `data`
 * canonicalized by JCS. The envelope keeps today's field order so that records
 * without integer-like keys keep their v1 hashes; JCS over the whole record would
 * sort it to `data, id, type` and change every hash.
 */
export function recordCanonical(id: string, type: string, data: unknown): string {
  return (
    '{"id":' + JSON.stringify(id) + ',"type":' + JSON.stringify(type) + ',"data":' + jcs(data) + '}'
  )
}

export function hashRecord(
  id: string,
  type: string,
  data: unknown,
): { hash: string; canonical: string } {
  const canonical = recordCanonical(id, type, data)
  return { hash: sha256Hex(canonical), canonical }
}

export function hashSchema(schema: unknown): string {
  return sha256Hex(jcs(schema))
}

// --- Legacy (format 1) hashing ----------------------------------------------
//
// Format 1 canonicalized by sorting keys into a new object and stringifying it,
// so integer-like keys came out first in numeric order. Kept for the negotiate
// compatibility layer and migration: v1 clients still send these hashes.

/** An "array index" key: JS enumerates these first, in numeric order. */
function isArrayIndexKey(k: string): boolean {
  if (k === '0') return true
  if (k.length === 0 || k.length > 10 || k.charCodeAt(0) < 0x31 || k.charCodeAt(0) > 0x39) {
    return false
  }
  for (let i = 1; i < k.length; i++) {
    const c = k.charCodeAt(i)
    if (c < 0x30 || c > 0x39) return false
  }
  return Number(k) < 4294967295
}

/** True when some object at any depth has an array-index key, the only case where v1 and v2 hashes can differ. */
export function hasArrayIndexKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasArrayIndexKey)
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isArrayIndexKey(k) || hasArrayIndexKey(v)) return true
  }
  return false
}

function legacyCanonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(legacyCanonicalize)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = legacyCanonicalize((value as Record<string, unknown>)[key])
  }
  return sorted
}

export function legacyRecordHash(id: string, type: string, data: unknown): string {
  return sha256Hex(JSON.stringify({ id, type, data: legacyCanonicalize(data) }))
}

export function legacySchemaHash(schema: unknown): string {
  return sha256Hex(JSON.stringify(legacyCanonicalize(schema)))
}
