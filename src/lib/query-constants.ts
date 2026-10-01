/**
 * Most collections the Query Explorer will load at once, and the most
 * generate-sql accepts. The UI enforces the same number, so a real user never
 * hits the server check. Client-safe: keep this file free of server imports.
 */
export const MAX_QUERY_COLLECTIONS = 5
