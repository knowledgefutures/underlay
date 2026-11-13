/**
 * Where a commit is, for the logs and for the session's status. A commit job the platform
 * ends (CPU, memory or wall time) runs no handler and logs nothing, so each step says when
 * it starts, and a long step says how far it has got, both on the session (`commit_step` and
 * `commit_step_at`, shown by the status route) and as a log event:
 *
 *   { event: 'push.commit', session, step, at: 'start' | 'progress' | 'end' | 'error', ms, … }
 *
 * A step that throws records its error on the session (`commit_last_error`), kept after the
 * session settles. Starting a step or reporting progress dates `progress_at`, so the sweep
 * leaves a commit that is moving alone. Neither clears the sweep's count of nudges
 * (push/recover.ts): a nudged job passes its first steps again each time, so a job that
 * dies at the same place every time must still fail. Only work that stays done clears it
 * (a compaction, a part of a build).
 */
import { and, eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'

export const traceConfig = {
  /** Progress within a step is written (and logged) at most this often. */
  progressMs: 30_000,
}

export interface CommitTrace {
  readonly sessionId: string
  /** Run one step of the commit, recorded as it starts, ends or throws. */
  step<T>(name: string, run: () => Promise<T>): Promise<T>
  /** How far the current step has got: written at most every `progressMs`, or now if `force`. */
  progress(detail: string, fields?: Record<string, unknown>, force?: boolean): Promise<void>
}

export function logCommit(fields: Record<string, unknown>): void {
  console.log({ event: 'push.commit', ...fields })
}

export function commitTrace(ports: Ports, sessionId: string): CommitTrace {
  const s = schema.pushSessions
  const committing = and(eq(s.id, sessionId), eq(s.status, 'committing'))
  const steps: { name: string; started: number }[] = []
  let lastWrite = 0
  const current = () => steps[steps.length - 1]
  return {
    sessionId,
    async step(name, run) {
      const started = Date.now()
      steps.push({ name, started })
      logCommit({ session: sessionId, step: name, at: 'start' })
      await ports.db
        .update(s)
        .set({ commitStep: name, commitStepAt: new Date(started), progressAt: new Date(started) })
        .where(committing)
      lastWrite = started
      try {
        const out = await run()
        const ms = Date.now() - started
        logCommit({ session: sessionId, step: name, at: 'end', ms })
        steps.pop()
        // `commit_step` stays the last step started, or the last progress reported: a commit
        // waiting on other jobs keeps saying how far they have got ("v3.parts: 3 of 14 parts
        // built"), not that the job which queued them returned.
        await ports.db.update(s).set({ progressAt: new Date() }).where(committing)
        return out
      } catch (err) {
        const ms = Date.now() - started
        const message = errorText(err)
        logCommit({ session: sessionId, step: name, at: 'error', ms, error: message })
        steps.pop()
        // The innermost step that threw names the error; the steps around it rethrow it.
        if (!(err instanceof Object && traced.has(err))) {
          if (err instanceof Object) traced.add(err)
          console.error(`[push] commit of session ${sessionId} threw in ${name}:`, err)
          await ports.db
            .update(s)
            .set({ commitLastError: { step: name, message, at: new Date().toISOString() } })
            .where(eq(s.id, sessionId))
            .catch(() => {})
        }
        throw err
      }
    },
    async progress(detail, fields = {}, force = false) {
      const now = Date.now()
      if (!force && now - lastWrite < traceConfig.progressMs) return
      lastWrite = now
      const step = current()?.name ?? 'commit'
      logCommit({
        session: sessionId,
        step,
        at: 'progress',
        ms: now - (current()?.started ?? now),
        detail,
        ...fields,
      })
      await ports.db
        .update(s)
        .set({ commitStep: `${step}: ${detail}`, progressAt: new Date(now) })
        .where(committing)
    },
  }
}

/** Errors already recorded by the step that threw them. */
const traced = new WeakSet<object>()

const errorText = (err: unknown) =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000)

/** A trace that records nothing (callers outside a session commit, and tests). */
export const noTrace: CommitTrace = {
  sessionId: '',
  step: (_name, run) => run(),
  progress: async () => {},
}
