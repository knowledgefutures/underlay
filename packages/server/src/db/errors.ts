/**
 * Whether a database error is a UNIQUE constraint failing: two requests that
 * checked a slug was free and then both inserted it. SQLite (better-sqlite3,
 * libsql) and D1 both say "UNIQUE constraint failed", D1 sometimes on the cause.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const message = (e as { message?: unknown }).message
    if (typeof message === 'string' && message.includes('UNIQUE constraint failed')) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}
