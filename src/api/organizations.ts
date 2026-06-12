import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { type AuthEnv } from './auth.server.js'
import { requireAuth } from './auth.server.js'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

const app = new Hono<AuthEnv>().post(
  '/',
  requireAuth('write'),
  openApi({
    tags: ['Organizations'],
    summary: 'Create an organization',
    request: {
      json: z.object({
        slug: z.string(),
        name: z.string().optional(),
      }),
    },
    responses: { 201: z.any() },
  }),
  async (c) => {
    const { slug, name } = c.req.valid('json')
    const userId = c.get('userId')!

    if (!slug || slug.length < 2 || slug.length > 64 || !SLUG_RE.test(slug)) {
      return c.json({ error: 'Invalid slug', statusCode: 422 }, 422)
    }

    const [existing] = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1)
    if (existing) {
      return c.json({ error: 'That slug is already taken', statusCode: 409 }, 409)
    }

    const orgId = uuidv4()
    await db.insert(schema.organization).values({
      id: orgId,
      name: name || slug,
      slug,
      isDefault: false,
    })
    await db.insert(schema.member).values({
      id: uuidv4(),
      organizationId: orgId,
      userId,
      role: 'owner',
    })

    return c.json({ id: orgId, slug, name: name || slug }, 201)
  },
)

export default app
