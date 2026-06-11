import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { KF_AUTH_INTERNAL_URL } from '../lib/auth.js'
import { type AuthEnv, requireAuth } from './auth.server.js'

const COMMENT_MAX_BYTES = 8192
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10
const rateBuckets = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  bucket.count++
  return bucket.count <= RATE_LIMIT_MAX
}

async function isSteward(userId: string | undefined): Promise<boolean> {
  if (!userId) return false
  try {
    const [acct] = await db
      .select({ accessToken: schema.account.accessToken })
      .from(schema.account)
      .where(eq(schema.account.userId, userId))
      .limit(1)
    if (!acct?.accessToken) return false
    const res = await fetch(`${KF_AUTH_INTERNAL_URL}/api/auth/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${acct.accessToken}` },
    })
    if (!res.ok) return false
    const profile = await res.json()
    return profile.role === 'admin'
  } catch {
    return false
  }
}

const createBody = z.object({
  anchor: z.string().min(1).max(200),
  quote: z.string().max(2000).optional(),
  quoteContext: z.object({ prefix: z.string().max(200), suffix: z.string().max(200) }).optional(),
  parentId: z.string().uuid().optional(),
  body: z.string().min(1).max(COMMENT_MAX_BYTES),
})

const patchBody = z.object({
  body: z.string().min(1).max(COMMENT_MAX_BYTES).optional(),
  approve: z.boolean().optional(),
  status: z.enum(['open', 'answered', 'decided', 'changed']).optional(),
  resolutionNote: z.string().max(2000).optional(),
})

const app = new Hono<AuthEnv>()
  .get('/pages/:page/comments', async (c) => {
    const page = c.req.param('page')
    const userId = c.get('userId')

    const comments = await db
      .select({
        id: schema.pageComments.id,
        page: schema.pageComments.page,
        anchor: schema.pageComments.anchor,
        quote: schema.pageComments.quote,
        quoteContext: schema.pageComments.quoteContext,
        parentId: schema.pageComments.parentId,
        userId: schema.pageComments.userId,
        body: schema.pageComments.body,
        approvedAt: schema.pageComments.approvedAt,
        status: schema.pageComments.status,
        resolutionNote: schema.pageComments.resolutionNote,
        createdAt: schema.pageComments.createdAt,
        editedAt: schema.pageComments.editedAt,
        authorName: schema.user.name,
        authorImage: schema.user.image,
      })
      .from(schema.pageComments)
      .innerJoin(schema.user, eq(schema.pageComments.userId, schema.user.id))
      .where(
        and(
          eq(schema.pageComments.page, page),
          isNull(schema.pageComments.deletedAt),
          userId
            ? sql`(${schema.pageComments.approvedAt} IS NOT NULL OR ${schema.pageComments.userId} = ${userId})`
            : isNotNull(schema.pageComments.approvedAt),
        ),
      )
      .orderBy(schema.pageComments.createdAt)

    const byAnchor: Record<string, typeof comments> = {}
    for (const comment of comments) {
      const key = comment.anchor
      if (!byAnchor[key]) byAnchor[key] = []
      byAnchor[key].push(comment)
    }

    return c.json({ comments: byAnchor })
  })

  .post('/pages/:page/comments', requireAuth('write'), async (c) => {
    const page = c.req.param('page')
    const userId = c.get('userId')!
    const rateKey = `discussion:${userId}`
    if (!checkRateLimit(rateKey)) {
      return c.json({ error: 'Rate limit exceeded', statusCode: 429 }, 429)
    }

    const parsed = createBody.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid request', details: parsed.error.flatten(), statusCode: 400 },
        400,
      )
    }

    const { anchor, quote, quoteContext, parentId, body } = parsed.data

    if (parentId) {
      const [parent] = await db
        .select({ id: schema.pageComments.id, parentId: schema.pageComments.parentId })
        .from(schema.pageComments)
        .where(
          and(
            eq(schema.pageComments.id, parentId),
            eq(schema.pageComments.page, page),
            isNull(schema.pageComments.deletedAt),
          ),
        )
        .limit(1)
      if (!parent) {
        return c.json({ error: 'Parent comment not found', statusCode: 404 }, 404)
      }
      if (parent.parentId) {
        return c.json({ error: 'Cannot nest replies deeper than one level', statusCode: 400 }, 400)
      }
    }

    const [comment] = await db
      .insert(schema.pageComments)
      .values({
        page,
        anchor,
        quote: quote ?? null,
        quoteContext: quoteContext ?? null,
        parentId: parentId ?? null,
        userId,
        body,
      })
      .returning()

    return c.json({ comment }, 201)
  })

  .patch('/pages/:page/comments/:id', requireAuth('write'), async (c) => {
    const commentId = c.req.param('id')
    const userId = c.get('userId')!

    const parsed = patchBody.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid request', details: parsed.error.flatten(), statusCode: 400 },
        400,
      )
    }

    const [existing] = await db
      .select()
      .from(schema.pageComments)
      .where(and(eq(schema.pageComments.id, commentId), isNull(schema.pageComments.deletedAt)))
      .limit(1)

    if (!existing) {
      return c.json({ error: 'Comment not found', statusCode: 404 }, 404)
    }

    const steward = await isSteward(userId)
    const isAuthor = existing.userId === userId

    if (parsed.data.body) {
      if (!isAuthor) {
        return c.json({ error: "Cannot edit another user's comment", statusCode: 403 }, 403)
      }
      if (existing.approvedAt && !steward) {
        return c.json({ error: 'Cannot edit an approved comment', statusCode: 403 }, 403)
      }
    }

    if (
      parsed.data.approve !== undefined ||
      parsed.data.status ||
      parsed.data.resolutionNote !== undefined
    ) {
      if (!steward) {
        return c.json({ error: 'Steward access required', statusCode: 403 }, 403)
      }
    }

    const updates: Record<string, any> = {}
    if (parsed.data.body) {
      updates.body = parsed.data.body
      updates.editedAt = new Date()
    }
    if (parsed.data.approve === true && steward) {
      updates.approvedAt = new Date()
      updates.approvedBy = userId
    }
    if (parsed.data.status && steward) {
      updates.status = parsed.data.status
    }
    if (parsed.data.resolutionNote !== undefined && steward) {
      updates.resolutionNote = parsed.data.resolutionNote
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No changes', statusCode: 400 }, 400)
    }

    const [updated] = await db
      .update(schema.pageComments)
      .set(updates)
      .where(eq(schema.pageComments.id, commentId))
      .returning()

    return c.json({ comment: updated })
  })

  .delete('/pages/:page/comments/:id', requireAuth('write'), async (c) => {
    const commentId = c.req.param('id')
    const userId = c.get('userId')!

    const [existing] = await db
      .select({ id: schema.pageComments.id, userId: schema.pageComments.userId })
      .from(schema.pageComments)
      .where(and(eq(schema.pageComments.id, commentId), isNull(schema.pageComments.deletedAt)))
      .limit(1)

    if (!existing) {
      return c.json({ error: 'Comment not found', statusCode: 404 }, 404)
    }

    const steward = await isSteward(userId)
    if (existing.userId !== userId && !steward) {
      return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
    }

    await db
      .update(schema.pageComments)
      .set({ deletedAt: new Date() })
      .where(eq(schema.pageComments.id, commentId))

    return c.json({ ok: true })
  })

  .get('/admin/discussion', requireAuth('write'), async (c) => {
    const userId = c.get('userId')!
    const steward = await isSteward(userId)
    if (!steward) {
      return c.json({ error: 'Steward access required', statusCode: 403 }, 403)
    }

    const pending = await db
      .select({
        id: schema.pageComments.id,
        page: schema.pageComments.page,
        anchor: schema.pageComments.anchor,
        quote: schema.pageComments.quote,
        body: schema.pageComments.body,
        createdAt: schema.pageComments.createdAt,
        authorName: schema.user.name,
        authorImage: schema.user.image,
      })
      .from(schema.pageComments)
      .innerJoin(schema.user, eq(schema.pageComments.userId, schema.user.id))
      .where(and(isNull(schema.pageComments.approvedAt), isNull(schema.pageComments.deletedAt)))
      .orderBy(schema.pageComments.createdAt)

    const allComments = await db
      .select({
        id: schema.pageComments.id,
        page: schema.pageComments.page,
        anchor: schema.pageComments.anchor,
        quote: schema.pageComments.quote,
        body: schema.pageComments.body,
        status: schema.pageComments.status,
        resolutionNote: schema.pageComments.resolutionNote,
        approvedAt: schema.pageComments.approvedAt,
        createdAt: schema.pageComments.createdAt,
        authorName: schema.user.name,
      })
      .from(schema.pageComments)
      .innerJoin(schema.user, eq(schema.pageComments.userId, schema.user.id))
      .where(and(isNull(schema.pageComments.deletedAt), isNull(schema.pageComments.parentId)))
      .orderBy(desc(schema.pageComments.createdAt))

    return c.json({ pending, threads: allComments })
  })

export default app
