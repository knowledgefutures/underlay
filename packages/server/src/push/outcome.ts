/**
 * What a finished commit means for its push session: the HTTP status and body a
 * client sees (synchronously, or by polling after an async commit), and the
 * session's final state. Shared by finalize.ts and the parallel commit's
 * assembly (parallel.ts).
 */
import { MissingFilesError } from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import { FenceError, StorageBusyError } from '../cleanup/fence.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import type { CommitResult } from '../versions/commit.js'
import { SESSION_TTL_MS, transition } from './session.js'

/** The one refusal a client can fix within the session: the session reopens (settleSession). */
export const MISSING_FILES = 'Missing files'

export interface Outcome {
  /** 202: a parallel commit is still running. 503: storage cleanup got in the way; push again. */
  status: 201 | 202 | 409 | 422 | 400 | 503
  body: Record<string, unknown>
}

export type SessionCommitResult =
  | CommitResult
  | { status: 'base_moved'; current: string | null }
  | { status: 'schema_refused'; error: string }
  | { status: 'parallel' }

export const pendingOutcome = (sessionId: string): Outcome => ({
  status: 202,
  body: { session_id: sessionId, status: 'committing' },
})

/** Run a commit and map its result (or a missing-files rejection) to an outcome. */
export async function commitOutcome(
  ports: Ports,
  sessionId: string,
  run: () => Promise<SessionCommitResult>,
): Promise<Outcome> {
  let r: SessionCommitResult
  try {
    r = await run()
  } catch (err) {
    // Only after `fenced` gave up (a parallel commit can't redo its units).
    if (err instanceof FenceError || err instanceof StorageBusyError) {
      return {
        status: 503,
        body: {
          error: 'Storage cleanup ran while this push was committing. Push again.',
          statusCode: 503,
        },
      }
    }
    if (!(err instanceof MissingFilesError)) throw err
    return {
      status: 422,
      body: {
        error: MISSING_FILES,
        filesNeeded: err.hashes.slice(0, 100),
        statusCode: 422,
      },
    }
  }
  switch (r.status) {
    case 'committed':
      return { status: 201, body: committedBody(r.version) }
    case 'no_changes':
      return {
        status: 409,
        body: {
          error: 'No changes detected',
          message: 'The head version already has identical content.',
          hash: r.versionHash,
          statusCode: 409,
        },
      }
    case 'conflict':
    case 'base_moved': {
      // The head moved, or another commit won it: if that commit was this
      // session's own (a job that ran twice), the push is committed.
      const own = await ownVersion(ports, sessionId)
      if (own) return { status: 201, body: committedBody(own) }
      // currentVersion, as the 409 at open has it.
      return {
        status: 409,
        body: {
          error: 'Version conflict',
          currentVersion:
            r.status === 'base_moved' ? r.current : await semverOf(ports, r.headVersionId),
          statusCode: 409,
        },
      }
    }
    case 'schema_refused':
      return { status: 422, body: { error: r.error, statusCode: 422 } }
    case 'invalid':
      return {
        status: 422,
        body: {
          error: 'Schema validation failed',
          validationErrors: r.errors,
          totalErrors: r.total,
          statusCode: 422,
        },
      }
    case 'parallel':
      return pendingOutcome(sessionId)
  }
}

type VersionRow = typeof schema.versions.$inferSelect

/** What a committed push returns, from its version row. */
function committedBody(v: VersionRow): Record<string, unknown> {
  return {
    semver: v.semver,
    hash: v.hash,
    recordCount: v.recordCount,
    fileCount: v.fileCount,
    changes: v.changes,
  }
}

/** The version this session committed, if it did. */
async function ownVersion(ports: Ports, sessionId: string): Promise<VersionRow | null> {
  const [v] = await ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.pushSessionId, sessionId))
    .limit(1)
  return v ?? null
}

async function semverOf(ports: Ports, versionId: string | null): Promise<string | null> {
  if (!versionId) return null
  const [v] = await ports.db
    .select({ semver: schema.versions.semver })
    .from(schema.versions)
    .where(eq(schema.versions.id, versionId))
  return v?.semver ?? null
}

/**
 * Record an outcome on the session: committing → committed | failed, or back to
 * open after a "Missing files" refusal, so the client can upload them and commit
 * the same session again (the error stays on the session for a polling client).
 * Only a committing session moves, so a settled one is never overwritten; false
 * if this call didn't move it (another run settled it first).
 */
export async function settleSession(
  ports: Ports,
  sessionId: string,
  outcome: Outcome,
): Promise<boolean> {
  if (outcome.status === 202) return true
  if (outcome.status === 422 && outcome.body.error === MISSING_FILES) {
    // A parallel plan is dropped: the next commit plans again, over any records
    // uploaded meanwhile. The old plan's jobs stop at the plan id check.
    return transition(ports, sessionId, 'committing', 'open', {
      error: outcome.body as never,
      finalizeStartedAt: null,
      commitPlan: null,
      assemblyLease: null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
  }
  const ok = outcome.status === 201
  return transition(
    ports,
    sessionId,
    'committing',
    ok ? 'committed' : 'failed',
    ok ? { result: outcome.body } : { error: outcome.body as never },
  )
}
