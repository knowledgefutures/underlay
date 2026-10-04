import { type SQL, sql } from 'drizzle-orm'

/**
 * D1 binds at most 100 parameters per statement and runs at most 1,000 queries
 * per Worker invocation. Short lists of values go into `IN (…)` in chunks of
 * IN_CHUNK; long ones (thousands of hashes) as one JSON parameter (inJson).
 */
export const IN_CHUNK = 90

/**
 * Values per inJson parameter: a bound value is at most 2 MB on D1, and a
 * 64-hex hash takes 67 bytes of JSON.
 */
export const JSON_CHUNK = 10_000

/** `col IN (the values)`, the values bound as one JSON array: one parameter however many. */
export const inJson = (col: unknown, values: readonly string[]): SQL =>
  sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`

export function chunks<T>(xs: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}
