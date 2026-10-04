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
