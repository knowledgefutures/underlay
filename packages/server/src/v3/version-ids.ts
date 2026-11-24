/**
 * Version ids in D1: `versions.hash` holds `ul:ver:<hex>` (docs/protocol/v3.md, Section 5.1).
 */
import { v3 } from '@underlay/protocol'
import { type Column, eq } from 'drizzle-orm'

/**
 * A condition on a column of v3 version ids: equal to `id`, given as `ul:ver:<hex>` or bare
 * hex. A string that is no version id matches as is.
 */
export function versionIdIs(column: Column, id: string) {
  const hex = v3.versionHex(id)
  return eq(column, hex === null ? id : v3.VERSION_ID_PREFIX + hex)
}
