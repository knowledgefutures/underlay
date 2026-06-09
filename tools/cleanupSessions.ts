/**
 * Delete old negotiate sessions (and, via cascade, their per-record manifest
 * rows). Sessions are only ever status-flipped during normal operation, so
 * without this job the negotiate_session_manifest table grows with every push.
 *
 * Removes sessions whose expiry is older than the grace period regardless of
 * status — committed and expired sessions have no further use, and an "open"
 * session past expiry can never be committed.
 */
import { lt, sql } from 'drizzle-orm'

import { db, schema } from '../src/db/client.server.js'

const GRACE_MS = 24 * 60 * 60 * 1000 // keep recent sessions for a day for debugging

async function main() {
  const cutoff = new Date(Date.now() - GRACE_MS)
  const deleted = await db
    .delete(schema.negotiateSessions)
    .where(lt(schema.negotiateSessions.expiresAt, cutoff))
    .returning({ id: schema.negotiateSessions.id })

  console.log(
    `[cleanup-sessions] Deleted ${deleted.length} negotiate session(s) expired before ${cutoff.toISOString()}`,
  )

  // Manifest rows cascade with their session; report the remaining footprint
  const [counts] = await db
    .select({
      sessions: sql<number>`(select count(*) from negotiate_sessions)::int`,
      manifestRows: sql<number>`(select count(*) from negotiate_session_manifest)::int`,
    })
    .from(sql`(select 1) as one`)
  console.log(
    `[cleanup-sessions] Remaining: ${counts?.sessions ?? 0} session(s), ${counts?.manifestRows ?? 0} manifest row(s)`,
  )

  process.exit(0)
}

main().catch((err) => {
  console.error('[cleanup-sessions] Failed:', err)
  process.exit(1)
})
