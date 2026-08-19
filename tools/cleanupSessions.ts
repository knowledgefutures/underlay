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
 *
 * Does the same for async metadata jobs, which strand the same way and, while
 * stranded, block further metadata edits on their collection.
 */
import { and, eq, lt, ne, sql } from 'drizzle-orm'

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

/**
 * Fail out stranded async metadata jobs.
 *
 * Unlike a negotiate finalize there is no partial version to clean up: the
 * metadata path builds its version in a single transaction with its final
 * `ready` status, so a process that dies mid-job leaves the version rolled back
 * and only the job row behind. Flipping it to 'failed' is what releases the
 * per-collection in-progress guard, so without this a dead job would block every
 * later metadata edit on that collection.
 */
async function sweepStrandedMetadataJobs() {
  const cutoff = new Date(Date.now() - FINALIZE_TIMEOUT_MS)
  const stranded = await db
    .update(schema.metadataJobs)
    .set({
      status: 'failed',
      error: {
        statusCode: 500,
        error: 'Metadata update did not complete — the process handling it went away.',
      },
      finishedAt: new Date(),
    })
    .where(
      and(eq(schema.metadataJobs.status, 'running'), lt(schema.metadataJobs.startedAt, cutoff)),
    )
    .returning({ id: schema.metadataJobs.id })

  if (stranded.length > 0) {
    console.log(
      `[cleanup-sessions] Failed ${stranded.length} stranded metadata job(s): ${stranded
        .map((j) => j.id)
        .join(', ')}`,
    )
  }
}

async function main() {
  await sweepStrandedFinalizes()
  await sweepStrandedMetadataJobs()

  const cutoff = new Date(Date.now() - GRACE_MS)
  const deleted = await db
    .delete(schema.negotiateSessions)
    .where(lt(schema.negotiateSessions.expiresAt, cutoff))
    .returning({ id: schema.negotiateSessions.id })

  console.log(
    `[cleanup-sessions] Deleted ${deleted.length} negotiate session(s) expired before ${cutoff.toISOString()}`,
  )

  // Finished metadata jobs are only kept so a client that polls late, or someone
  // reading back a failure, still gets an answer. One row per metadata edit, so
  // this is housekeeping rather than a real growth problem.
  const deletedJobs = await db
    .delete(schema.metadataJobs)
    .where(
      and(ne(schema.metadataJobs.status, 'running'), lt(schema.metadataJobs.finishedAt, cutoff)),
    )
    .returning({ id: schema.metadataJobs.id })
  if (deletedJobs.length > 0) {
    console.log(`[cleanup-sessions] Deleted ${deletedJobs.length} finished metadata job(s)`)
  }

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
