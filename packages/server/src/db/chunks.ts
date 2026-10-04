/**
 * D1 binds at most 100 parameters per statement and runs at most 1,000 queries
 * per Worker invocation. Lists of values go into `IN (…)` in chunks of IN_CHUNK.
 */
export const IN_CHUNK = 90

export function chunks<T>(xs: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}
