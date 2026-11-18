/**
 * Version ids in D1 (record-references.md, decision 7).
 *
 * Until 2026-11-18 a v3 version id was written `ulv3:<hex>`; it is now `ul:ver:<hex>`, the
 * same hash. `versions.hash` rows written before are moved to the new form by the cron
 * (`backfillVersionIds`), a batch a tick, so new code never depends on the order of a
 * deploy and a migration. Until a deployment's backfill is done, a row may hold either
 * spelling, so lookups by id ask for both.
 */
import { v3 } from '@underlay/protocol'
import { type Column, eq, inArray, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'

const OLD = v3.LEGACY_VERSION_ID_PREFIX
const NEW = v3.VERSION_ID_PREFIX

/**
 * A condition on a column of v3 version ids: equal to `id`, given in any form `versionHex`
 * reads, whichever way the row spells it. A string that is no version id matches as is.
 */
export function versionIdIs(column: Column, id: string) {
  const hex = v3.versionHex(id)
  return hex === null ? eq(column, id) : inArray(column, [NEW + hex, OLD + hex])
}

/** Rows moved a tick; a deployment holds a few thousand versions. */
const BATCH = 500
const DONE = 'backfills/version-ids-ul-ver.done'

/** Move `versions.hash` from `ulv3:` to `ul:ver:`, a batch a tick, until none is left. */
export async function backfillVersionIds(ports: Ports): Promise<number> {
  if (await ports.stores.internal.head(DONE)) return 0
  const moved = await ports.db
    .update(schema.versions)
    .set({ hash: sql`${NEW} || substr(${schema.versions.hash}, ${OLD.length + 1})` })
    .where(
      inArray(
        schema.versions.id,
        ports.db
          .select({ id: schema.versions.id })
          .from(schema.versions)
          .where(sql`substr(${schema.versions.hash}, 1, ${OLD.length}) = ${OLD}`)
          .limit(BATCH),
      ),
    )
    .returning({ id: schema.versions.id })
  if (moved.length < BATCH) await ports.stores.internal.put(DONE, new Date().toISOString())
  if (moved.length > 0) console.log(`[v3] version ids: ${moved.length} moved to ul:ver:`)
  return moved.length
}
