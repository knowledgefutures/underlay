/**
 * Keyset cursor for the paged `/records` endpoint.
 *
 * A version can hold the same `record_id` under more than one type (and more than
 * one body), so an id alone can't mark a page boundary: the rows that share the
 * boundary id would be skipped. The position is the (record_id, record_hash) pair,
 * the same key the manifest and NDJSON paths use, carried as one opaque token.
 *
 * `?after=` also still accepts a bare record id, which resumes strictly past
 * that id — the pre-cursor behavior — so older clients keep working.
 */

export type RecordsAfter =
  | { kind: 'pair'; recordId: string; recordHash: string }
  | { kind: 'id'; recordId: string }

export const encodeRecordsCursor = (recordId: string, recordHash: string): string =>
  Buffer.from(JSON.stringify({ r: [recordId, recordHash] }), 'utf-8').toString('base64url')

/**
 * Anything that isn't a well-formed cursor is treated as a bare record id, so an
 * id that happens to look like base64 degrades to the old behavior, not an error.
 */
export function decodeRecordsAfter(raw: string): RecordsAfter {
  if (/^[A-Za-z0-9_-]+$/.test(raw)) {
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as {
        r?: unknown
      } | null
      const r = parsed?.r
      if (
        Array.isArray(r) &&
        r.length === 2 &&
        typeof r[0] === 'string' &&
        typeof r[1] === 'string'
      ) {
        return { kind: 'pair', recordId: r[0], recordHash: r[1] }
      }
    } catch {
      // not a cursor
    }
  }
  return { kind: 'id', recordId: raw }
}
