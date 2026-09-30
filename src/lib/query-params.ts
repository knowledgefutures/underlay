/**
 * Parse a `?limit=` query value: the default when absent, non-numeric or
 * negative (which would otherwise reach SQL as NaN or a negative LIMIT and 500),
 * capped at `max`.
 */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = parseInt(raw ?? '', 10)
  return Math.min(Number.isNaN(n) || n < 0 ? fallback : n, max)
}

/** Parse a `?offset=` query value: 0 when absent, non-numeric or negative. */
export function parseOffset(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isNaN(n) || n < 0 ? 0 : n
}
