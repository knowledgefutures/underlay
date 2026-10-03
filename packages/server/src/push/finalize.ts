/**
 * Finishing a push session: run the commit and record the outcome on the
 * session, whether it runs inside the request or as a job. The session moves
 * open → committing (by the caller) → committed | failed; `result` holds what a
 * synchronous commit returns, `error` the rejection. A large delta commit may
 * instead plan a parallel commit (parallel.ts), whose assembly job settles the
 * session later.
 */
import { and, eq, lt } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { commitDeltaSession } from './delta.js'
import { commitNegotiateSession } from './negotiate.js'
import { commitOutcome, type Outcome, pendingOutcome, settleSession } from './outcome.js'
import { resumeParallel } from './parallel.js'
import { getSession } from './session.js'

export type { Outcome } from './outcome.js'

export async function finalizeSession(ports: Ports, sessionId: string): Promise<Outcome> {
  const session = await getSession(ports, sessionId)
  if (!session) return { status: 400, body: { error: 'Session not found', statusCode: 400 } }
  if (session.status === 'committed') return { status: 201, body: session.result ?? {} }
  if (session.status === 'failed')
    return {
      status: (session.error?.statusCode ?? 400) as Outcome['status'],
      body: session.error ?? {},
    }
  // A parallel commit already planned: make sure its jobs are queued, and wait.
  if (session.commitPlan) {
    await resumeParallel(ports, session)
    return pendingOutcome(sessionId)
  }
  const outcome = await commitOutcome(sessionId, () =>
    session.kind === 'delta'
      ? commitDeltaSession(ports, session)
      : commitNegotiateSession(ports, session),
  )
  await settleSession(ports, sessionId, outcome)
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
