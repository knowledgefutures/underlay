/**
 * Push sessions. A session collects uploads against a base version and ends in
 * one commit. Its inputs whose size the user controls (schemas, metadata,
 * declared files) are an object in the platform's internal area; uploads are
 * sorted runs (runs.ts). SQLite holds only the session row, counters and the run
 * list.
 */
import { hashSchema } from '@underlay/protocol'
import { and, asc, count, eq, gt, or, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { maybeCompact } from './compact.js'
import { readRunIndex, type RunIndex } from './runs.js'

/** Idle timeout: pushed back by every upload. Runs live in storage, so this can be generous. */
export const SESSION_TTL_MS = 60 * 60 * 1000

/** Sessions one user may have open or committing at once (v2-scale-review.md S3). */
export const limits = { openSessions: 20 }

/** Refused: the user already has `limits.openSessions` sessions in progress. */
export class SessionCapError extends Error {
  constructor(readonly open: number) {
    super(
      `You have ${open} push sessions in progress, the most allowed. Commit or abort one (DELETE …/push/:id), or let it expire, then try again.`,
    )
    this.name = 'SessionCapError'
  }
}

export interface SessionInputs {
  /** The full new type set: slug → schema. */
  schemas: Record<string, Record<string, unknown>>
  /** The full new metadata. */
  metadata: Record<string, unknown> | null
  /** Declared files to add and remove. */
  files: { add: string[]; remove: string[] }
}

export type SessionRow = typeof schema.pushSessions.$inferSelect

const inputsKey = (id: string) => `sessions/${id}/inputs.json`

export async function createSession(
  ports: Ports,
  row: Omit<typeof schema.pushSessions.$inferInsert, 'id' | 'expiresAt'>,
  inputs: SessionInputs,
): Promise<SessionRow> {
  const [inProgress] = await ports.db
    .select({ n: count() })
    .from(schema.pushSessions)
    .where(
      and(
        eq(schema.pushSessions.userId, row.userId),
        or(
          eq(schema.pushSessions.status, 'committing'),
          and(
            eq(schema.pushSessions.status, 'open'),
            gt(schema.pushSessions.expiresAt, new Date()),
          ),
        ),
      ),
    )
  if ((inProgress?.n ?? 0) >= limits.openSessions) throw new SessionCapError(inProgress!.n)
  const id = crypto.randomUUID()
  // Inputs first: a session row never points at missing inputs.
  await ports.stores.internal.put(inputsKey(id), JSON.stringify(inputs), {
    contentType: 'application/json',
  })
  const [session] = await ports.db
    .insert(schema.pushSessions)
    .values({ ...row, id, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .returning()
  return session!
}

export async function loadInputs(ports: Ports, sessionId: string): Promise<SessionInputs> {
  const obj = await ports.stores.internal.get(inputsKey(sessionId))
  if (!obj) throw new Error(`Session ${sessionId} has no inputs`)
  return JSON.parse(await obj.text()) as SessionInputs
}

export async function getSession(ports: Ports, sessionId: string): Promise<SessionRow | null> {
  const [s] = await ports.db
    .select()
    .from(schema.pushSessions)
    .where(eq(schema.pushSessions.id, sessionId))
    .limit(1)
  return s ?? null
}

/** Claim the next run number for an open session and push back its expiry, atomically. */
export async function nextRunSeq(ports: Ports, sessionId: string): Promise<number | null> {
  const [row] = await ports.db
    .update(schema.pushSessions)
    .set({
      runs: sql`${schema.pushSessions.runs} + 1`,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .where(and(eq(schema.pushSessions.id, sessionId), eq(schema.pushSessions.status, 'open')))
    .returning({ runs: schema.pushSessions.runs })
  return row?.runs ?? null
}

export async function recordRun(
  ports: Ports,
  sessionId: string,
  kind: 'records' | 'deletes',
  index: RunIndex,
  counters: { records?: number },
): Promise<void> {
  const count = index.blocks.reduce((n, b) => n + b.count, 0)
  await ports.db.batch([
    ports.db.insert(schema.pushRuns).values({
      sessionId,
      seq: index.seq,
      kind,
      objectKey: `sessions/${sessionId}/runs/${index.seq}`,
      count,
      firstKey: index.blocks[0]?.first ?? '',
      lastKey: index.blocks[index.blocks.length - 1]?.last ?? '',
      tier: index.tier ?? 0,
    }),
    ports.db
      .update(schema.pushSessions)
      .set({
        recordsReceived: sql`${schema.pushSessions.recordsReceived} + ${counters.records ?? 0}`,
      })
      .where(eq(schema.pushSessions.id, sessionId)),
  ])
  await maybeCompact(ports, sessionId, kind, index.tier ?? 0)
}

export async function sessionRuns(
  ports: Ports,
  sessionId: string,
  kind?: 'records' | 'deletes',
): Promise<RunIndex[]> {
  const rows = await ports.db
    .select()
    .from(schema.pushRuns)
    .where(
      kind
        ? and(eq(schema.pushRuns.sessionId, sessionId), eq(schema.pushRuns.kind, kind))
        : eq(schema.pushRuns.sessionId, sessionId),
    )
    .orderBy(asc(schema.pushRuns.seq))
  return Promise.all(rows.map((r) => readRunIndex(ports.stores.internal, sessionId, r.seq)))
}

/** Move a session between statuses only from an expected one (compare-and-swap). */
export async function transition(
  ports: Ports,
  sessionId: string,
  from: schema.SessionStatus,
  to: schema.SessionStatus,
  extra: Partial<typeof schema.pushSessions.$inferInsert> = {},
): Promise<boolean> {
  const rows = await ports.db
    .update(schema.pushSessions)
    .set({ status: to, ...extra })
    .where(and(eq(schema.pushSessions.id, sessionId), eq(schema.pushSessions.status, from)))
    .returning({ id: schema.pushSessions.id })
  return rows.length === 1
}

export const schemaHashes = (schemas: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(schemas).map(([slug, s]) => [slug, hashSchema(s)]))
