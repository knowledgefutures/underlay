/**
 * Finishing a push session: run the commit and record the outcome on the
 * session, whether it runs inside the request or as a job. The session moves
 * open → committing (by the caller) → committed | failed; `result` holds what a
 * synchronous commit returns, `error` the rejection.
 */
import { and, eq, lt } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { MissingFilesError } from '../versions/file-refs.js'
import { commitDeltaSession } from './delta.js'
import { commitNegotiateSession } from './negotiate.js'
import { getSession, transition } from './session.js'

export interface Outcome {
  status: 201 | 409 | 422 | 400
  body: Record<string, unknown>
}

export async function finalizeSession(ports: Ports, sessionId: string): Promise<Outcome> {
  const session = await getSession(ports, sessionId)
  if (!session) return { status: 400, body: { error: 'Session not found', statusCode: 400 } }
  if (session.status === 'committed') return { status: 201, body: session.result ?? {} }
  if (session.status === 'failed')
    return {
      status: (session.error?.statusCode ?? 400) as Outcome['status'],
      body: session.error ?? {},
    }

  let outcome: Outcome
  try {
    const r = await (session.kind === 'delta'
      ? commitDeltaSession(ports, session)
      : commitNegotiateSession(ports, session))
    switch (r.status) {
      case 'committed':
        outcome = {
          status: 201,
          body: {
            semver: r.version.semver,
            hash: r.version.hash,
            recordCount: r.version.recordCount,
            fileCount: r.version.fileCount,
            changes: r.version.changes,
          },
        }
        break
      case 'no_changes':
        outcome = {
          status: 409,
          body: {
            error: 'No changes detected',
            message: 'The head version already has identical content.',
            hash: r.versionHash,
            statusCode: 409,
          },
        }
        break
      case 'conflict':
      case 'base_moved':
        outcome = { status: 409, body: { error: 'Version conflict', statusCode: 409 } }
        break
      case 'manifest_error':
        outcome = { status: 400, body: r.body }
        break
      case 'invalid':
        outcome = {
          status: 422,
          body: {
            error: 'Schema validation failed',
            validationErrors: r.errors,
            totalErrors: r.total,
            statusCode: 422,
          },
        }
        break
    }
  } catch (err) {
    if (!(err instanceof MissingFilesError)) throw err
    outcome = {
      status: 422,
      body: {
        error: 'Missing files',
        filesNeeded: err.hashes.slice(0, 100).map((h) => `sha256:${h}`),
        statusCode: 422,
      },
    }
  }

  const ok = outcome.status === 201
  await transition(
    ports,
    sessionId,
    'committing',
    ok ? 'committed' : 'failed',
    ok ? { result: outcome.body } : { error: outcome.body as never },
  )
  return outcome
}

/** Mark sessions whose idle timeout passed as expired (their objects expire by lifecycle rule). */
export async function expireSessions(ports: Ports): Promise<void> {
  await ports.db
    .update(schema.pushSessions)
    .set({ status: 'expired' })
    .where(
      and(eq(schema.pushSessions.status, 'open'), lt(schema.pushSessions.expiresAt, new Date())),
    )
}
