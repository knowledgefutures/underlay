/**
 * Pure helpers behind the negotiate session counters (`manifest_received`,
 * `manifest_needed`), kept apart from the database code so the arithmetic can be
 * tested without one.
 */

/** Keep the first entry for each hash; a manifest may repeat a record. */
export function dedupeByHash<T extends { hash: string }>(entries: T[]): T[] {
  const seen = new Set<string>()
  return entries.filter((e) => {
    if (seen.has(e.hash)) return false
    seen.add(e.hash)
    return true
  })
}

/**
 * What a manifest INSERT added to the session's counters, from the rows it
 * actually inserted (`ON CONFLICT DO NOTHING ... RETURNING`). Rows that already
 * existed — a retried chunk — are absent from `inserted`, so they add nothing.
 */
export function tallyInserted(inserted: { needed: boolean }[]): {
  received: number
  needed: number
} {
  let needed = 0
  for (const r of inserted) if (r.needed) needed++
  return { received: inserted.length, needed }
}
