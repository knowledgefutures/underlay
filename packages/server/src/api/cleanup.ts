/**
 * Storage cleanup for stewards (planning: v2-storage-cleanup.md):
 *
 *   GET  /api/admin/cleanup         runs, what's waiting, the fence, the automatic switch
 *   POST /api/admin/cleanup/runs    {step: internal|mark|sweep, dryRun?, thenSweep?} starts a run
 *   PUT  /api/admin/cleanup/auto    {enabled} the weekly automatic mark and sweep
 */
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { AUTO_SETTING, cleanupConfig } from '../cleanup/config.js'
import { fenceConfig, fenceState } from '../cleanup/fence.js'
import { CleanupRefused, startRun } from '../cleanup/runs.js'
import * as schema from '../db/schema.js'
import { jsonError } from './access.js'
import { stewardOnly } from './admin.js'

const STEPS: schema.CleanupStep[] = ['internal', 'mark', 'sweep']
const TERMINAL: schema.SessionStatus[] = ['committed', 'failed', 'expired']

export function cleanupRoutes() {
  const app = new Hono<AppEnv>()

  app.use('/api/admin/cleanup', async (c, next) => (await stewardOnly(c)) ?? next())
  app.use('/api/admin/cleanup/*', async (c, next) => (await stewardOnly(c)) ?? next())

  app.get('/api/admin/cleanup', async (c) => {
    const { db } = c.var.ports
    const now = Date.now()
    const graceStart = new Date(now - cleanupConfig.tombstoneGraceMs)
    const [runs, fence, auto, sessions, uploads, lastSweep, lastMark] = await Promise.all([
      db.select().from(schema.cleanupRuns).orderBy(desc(schema.cleanupRuns.createdAt)).limit(30),
      fenceState(db),
      db
        .select({ value: schema.instanceSettings.value })
        .from(schema.instanceSettings)
        .where(eq(schema.instanceSettings.key, AUTO_SETTING)),
      db
        .select({
          ready: sql<number>`sum(CASE WHEN ${schema.pushSessions.expiresAt} < ${now - cleanupConfig.sessionGraceMs} THEN 1 ELSE 0 END)`,
          later: sql<number>`count(*)`,
        })
        .from(schema.pushSessions)
        .where(
          and(isNull(schema.pushSessions.cleanedAt), inArray(schema.pushSessions.status, TERMINAL)),
        ),
      db
        .select({ n: sql<number>`count(*)` })
        .from(schema.fileUploads)
        .where(
          and(
            eq(schema.fileUploads.status, 'pending'),
            lt(schema.fileUploads.createdAt, new Date(now - cleanupConfig.uploadGraceMs)),
          ),
        ),
      db
        .select()
        .from(schema.cleanupRuns)
        .where(
          and(
            eq(schema.cleanupRuns.step, 'sweep'),
            eq(schema.cleanupRuns.status, 'done'),
            eq(schema.cleanupRuns.dryRun, false),
          ),
        )
        .orderBy(desc(schema.cleanupRuns.createdAt))
        .limit(1),
      db
        .select()
        .from(schema.cleanupRuns)
        .where(and(eq(schema.cleanupRuns.step, 'mark'), eq(schema.cleanupRuns.status, 'done')))
        .orderBy(desc(schema.cleanupRuns.createdAt))
        .limit(1),
    ])

    // Deleted collections a finished sweep hasn't reached: those still in their
    // grace period when its mark began, or deleted since.
    const markedAt = Number(lastSweep[0]?.state?.markStartedAt ?? 0)
    const since = new Date(markedAt ? markedAt - cleanupConfig.tombstoneGraceMs : 0)
    const [deleted] = await db
      .select({
        inGrace: sql<number>`sum(CASE WHEN ${schema.collectionTombstones.deletedAt} > ${graceStart.getTime()} THEN 1 ELSE 0 END)`,
        inGraceBytes: sql<number>`sum(CASE WHEN ${schema.collectionTombstones.deletedAt} > ${graceStart.getTime()} THEN ${schema.collectionTombstones.totalBytes} ELSE 0 END)`,
        ready: sql<number>`sum(CASE WHEN ${schema.collectionTombstones.deletedAt} <= ${graceStart.getTime()} THEN 1 ELSE 0 END)`,
        readyBytes: sql<number>`sum(CASE WHEN ${schema.collectionTombstones.deletedAt} <= ${graceStart.getTime()} THEN ${schema.collectionTombstones.totalBytes} ELSE 0 END)`,
      })
      .from(schema.collectionTombstones)
      .where(gt(schema.collectionTombstones.deletedAt, since))

    const until = fence?.windowUntil?.getTime()
    return c.json({
      runs: runs.map((r) => ({
        id: r.id,
        step: r.step,
        status: r.status,
        trigger: r.trigger,
        dryRun: r.dryRun,
        requestedBy: r.requestedBy,
        markRunId: r.markRunId,
        error: r.error,
        stats: r.stats,
        createdAt: r.createdAt.getTime(),
        startedAt: r.startedAt?.getTime() ?? null,
        finishedAt: r.finishedAt?.getTime() ?? null,
      })),
      auto: auto[0]?.value === true,
      fence: {
        epoch: fence?.epoch ?? 0,
        windowOpen: until !== undefined && until > now - fenceConfig.slackMs,
      },
      waiting: {
        sessions: Number(sessions[0]?.ready ?? 0),
        sessionsInGrace: Number(sessions[0]?.later ?? 0) - Number(sessions[0]?.ready ?? 0),
        uploads: Number(uploads[0]?.n ?? 0),
      },
      deletedCollections: {
        inGrace: {
          collections: Number(deleted?.inGrace ?? 0),
          bytes: Number(deleted?.inGraceBytes ?? 0),
        },
        ready: {
          collections: Number(deleted?.ready ?? 0),
          bytes: Number(deleted?.readyBytes ?? 0),
        },
      },
      lastMark: lastMark[0]
        ? {
            id: lastMark[0].id,
            startedAt: lastMark[0].startedAt?.getTime() ?? null,
            finishedAt: lastMark[0].finishedAt?.getTime() ?? null,
            marked: lastMark[0].stats?.marked ?? 0,
          }
        : null,
      config: {
        sessionGraceHours: cleanupConfig.sessionGraceMs / 3_600_000,
        uploadGraceHours: cleanupConfig.uploadGraceMs / 3_600_000,
        tombstoneGraceDays: cleanupConfig.tombstoneGraceMs / 86_400_000,
      },
    })
  })

  app.post('/api/admin/cleanup/runs', async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      step?: unknown
      dryRun?: unknown
      thenSweep?: unknown
    } | null
    const step = b?.step as schema.CleanupStep
    if (!STEPS.includes(step)) return jsonError(c, 400, 'step is internal, mark or sweep')
    try {
      const run = await startRun(c.var.ports, step, {
        trigger: 'manual',
        dryRun: b?.dryRun === true,
        thenSweep: b?.thenSweep === true,
        requestedBy: c.var.principal?.userId ?? null,
      })
      return c.json({ ok: true, id: run.id }, 202)
    } catch (err) {
      if (err instanceof CleanupRefused) return jsonError(c, 409, err.message)
      throw err
    }
  })

  app.put('/api/admin/cleanup/auto', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
    if (typeof b?.enabled !== 'boolean') return jsonError(c, 400, 'enabled must be true or false')
    await c.var.ports.db
      .insert(schema.instanceSettings)
      .values({ key: AUTO_SETTING, value: b.enabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.instanceSettings.key,
        set: { value: b.enabled, updatedAt: new Date() },
      })
    return c.json({ ok: true, enabled: b.enabled })
  })

  return app
}
