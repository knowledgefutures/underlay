/**
 * Finishing a push session: run the commit and record the outcome on the
 * session, whether it runs inside the request or as a job. The session moves
 * open → committing (by the caller) → committed | failed, or back to open after
 * a "Missing files" refusal; `result` holds what a synchronous commit returns,
 * `error` the rejection. A large delta commit may instead plan a parallel commit
 * (parallel.ts), whose assembly job settles the session later. A commit that
 * runs twice settles once: the second finds its own version (outcome.ts).
 */
import { and, eq, lt } from 'drizzle-orm'

import { fenced } from '../cleanup/fence.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { commitDeltaSession } from './delta.js'
import {
  commitOutcome,
  type Outcome,
  pendingOutcome,
  type SessionCommitResult,
  settleSession,
} from './outcome.js'
import { resumeParallel } from './parallel.js'
import { getSession, type SessionRow } from './session.js'

export type { Outcome } from './outcome.js'

export async function finalizeSession(ports: Ports, sessionId: string): Promise<Outcome> {
  const session = await getSession(ports, sessionId)
  if (!session) return { status: 400, body: { error: 'Session not found', statusCode: 400 } }
  // Only a committing session commits: a job delivered again after the session
  // settled, or reopened after "Missing files", reports what's recorded.
  if (session.status !== 'committing') return recorded(session)
  // A parallel commit already planned: make sure its jobs are queued, and wait.
  if (session.commitPlan) {
    await resumeParallel(ports, session)
    return pendingOutcome(sessionId)
  }
  // The change streams are rebuilt from the session's runs on each attempt.
  const outcome = await commitOutcome(ports, sessionId, () =>
    fenced<SessionCommitResult>(ports.db, (fence) => commitDeltaSession(ports, session, fence)),
  )
  if (await settleSession(ports, sessionId, outcome)) return outcome
  // Another run settled it first: its outcome is the session's.
  const now = await getSession(ports, sessionId)
  return now ? recorded(now) : outcome
}

/** The outcome a session that isn't committing has recorded. */
function recorded(session: SessionRow): Outcome {
  if (session.status === 'committed') return { status: 201, body: session.result ?? {} }
  if (session.status === 'committing') return pendingOutcome(session.id)
  if (session.error)
    return {
      status: (session.error.statusCode ?? 400) as Outcome['status'],
      body: session.error,
    }
  return {
    status: 409,
    body: { error: `Session is ${session.status}`, statusCode: 409 },
  }
}

/** Mark sessions whose idle timeout passed as expired (storage cleanup deletes their objects later). */
export async function expireSessions(ports: Ports): Promise<void> {
  await ports.db
    .update(schema.pushSessions)
    .set({ status: 'expired' })
    .where(
      and(eq(schema.pushSessions.status, 'open'), lt(schema.pushSessions.expiresAt, new Date())),
    )
}
