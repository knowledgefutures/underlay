/**
 * Delete old negotiate sessions (and, via cascade, their per-record manifest
 * rows). Sessions are only ever status-flipped during normal operation, so
 * without this job the negotiate_session_manifest table grows with every push.
 *
 * Removes sessions whose expiry is older than the grace period regardless of
 * status — committed and expired sessions have no further use, and an "open"
 * session past expiry can never be committed.
 *
 * Also fails out stranded async finalizes. A background finalize that dies with
 * its process (deploy, OOM, crash) leaves its session in 'committing' and its
 * version in 'creating' forever; nothing else will ever move them, and the
 * half-built version is invisible to readers but still holds version_records
 * rows. Anything still 'committing' well past the point a finalize could
 * plausibly still be running is treated as dead.
 */
import { and, eq, lt, sql } from 'drizzle-orm'

import { db, schema } from '../src/db/client.server.js'

const GRACE_MS = 24 * 60 * 60 * 1000 // keep recent sessions for a day for debugging

// Generous: a multi-million-record finalize legitimately runs for many minutes,
// and failing a live one would be worse than leaving a dead one an hour longer.
const FINALIZE_TIMEOUT_MS = 2 * 60 * 60 * 1000

async function sweepStrandedFinalizes() {
  const cutoff = new Date(Date.now() - FINALIZE_TIMEOUT_MS)
  const stranded = await db
    .select({
      id: schema.negotiateSessions.id,
      collectionId: schema.negotiateSessions.collectionId,
    })
    .from(schema.negotiateSessions)
    .where(
      and(
        eq(schema.negotiateSessions.status, 'committing'),
        lt(schema.negotiateSessions.finalizeStartedAt, cutoff),
      ),
    )

  if (stranded.length === 0) return

  for (const session of stranded) {
    // Drop the half-built version. It was never flipped to 'ready', so no reader
    // has seen it; version_records cascade with it.
    const removed = await db
      .delete(schema.versions)
      .where(
        and(
          eq(schema.versions.collectionId, session.collectionId),
          eq(schema.versions.status, 'creating'),
        ),
      )
      .returning({ semver: schema.versions.semver })

    await db
      .update(schema.negotiateSessions)
      .set({
        status: 'failed',
        error: {
          statusCode: 500,
          error: 'Finalize did not complete — the process handling it went away.',
        },
      })
      .where(eq(schema.negotiateSessions.id, session.id))

    console.log(
      `[cleanup-sessions] Failed stranded finalize ${session.id}` +
        (removed.length > 0 ? `, removed partial version(s) ${removed.map((r) => r.semver)}` : ''),
    )
  }
}

async function main() {
  await sweepStrandedFinalizes()

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
