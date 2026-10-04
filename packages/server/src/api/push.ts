/**
 * Push routes, mounted at /api/collections.
 *
 * Delta push, the protocol's one way to publish (docs/protocol-v2.md, section 11.4):
 *   POST   /:owner/:slug/push                      open a session against a base
 *   POST   /:owner/:slug/push/:sid/records         NDJSON {id,type,data,private?}
 *   POST   /:owner/:slug/push/:sid/deletes         NDJSON {type,id}
 *   POST   /:owner/:slug/push/:sid/commit          ?async=true for a job
 *   GET    /:owner/:slug/push/:sid                 status (and result after an async commit)
 *   DELETE /:owner/:slug/push/:sid                 abandon
 */
import { checkSchema, fileTree, getEntry, parseSemver, RepoSource } from '@underlay/protocol'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { SMALL_UPLOAD_BYTES } from '../files/files.js'
import { registerJob } from '../jobs.js'
import {
  headBase,
  ingestDeletes,
  ingestRecords,
  MAX_BATCH_BYTES,
  MAX_BATCH_LINES,
} from '../push/delta.js'
import { finalizeSession } from '../push/finalize.js'
import {
  createSession,
  getSession,
  limits,
  SESSION_TTL_MS,
  type SessionInputs,
  type SessionRow,
  transition,
} from '../push/session.js'
import { type CollectionAccess, jsonError, requireCollection } from './access.js'
import { BodyTooLarge, readJson, readLines, readText } from './body.js'

const MAX_OPEN_BYTES = 8 * 1024 * 1024
/** Commits above this many uploaded records run as a job even without ?async. */
const ASYNC_ABOVE = 100_000

/**
 * This node's push limits, advertised when a session opens (docs/protocol-v2.md,
 * section 11.4). Read on each call: tests lower some of them.
 */
export const pushLimits = () => ({
  open_bytes: MAX_OPEN_BYTES,
  batch_bytes: MAX_BATCH_BYTES,
  batch_lines: MAX_BATCH_LINES,
  session_idle_seconds: SESSION_TTL_MS / 1000,
  open_sessions: limits.openSessions,
  file_bytes: SMALL_UPLOAD_BYTES,
})

registerJob('push.commit', async (job, ports) => {
  await finalizeSession(ports, String(job.sessionId))
})

async function readNdjson(c: Context<AppEnv>): Promise<string | Response> {
  try {
    return await readText(c, MAX_BATCH_BYTES)
  } catch (err) {
    if (err instanceof BodyTooLarge)
      return jsonError(c, 413, `Batches are limited to ${MAX_BATCH_BYTES} bytes`)
    throw err
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Validate a full schema set. Returns an error message or null. */
function checkSchemas(schemas: unknown): string | null {
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas))
    return '"schemas" must be an object of type → schema'
  for (const [slug, body] of Object.entries(schemas)) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return `Schema "${slug}" must be an object`
    const err = checkSchema(slug, body)
    if (err) return err
  }
  return null
}

/** The session named in the URL, if it belongs to this collection and caller. */
async function ownSession(
  c: Context<AppEnv>,
  access: CollectionAccess,
): Promise<SessionRow | Response> {
  const session = await getSession(c.var.ports, c.req.param('sid') ?? '')
  if (!session || session.collectionId !== access.collection.id) {
    return jsonError(c, 404, 'Session not found')
  }
  if (session.userId !== c.var.principal?.userId) return jsonError(c, 403, 'Not your session')
  return session
}

/** The schemas and metadata of a base version (for sessions that keep them). */
async function baseInputs(c: Context<AppEnv>, collectionId: string, baseHash: string | null) {
  if (!baseHash) return { schemas: {}, metadata: null }
  const repo = await c.var.ports.stores.forCollection(collectionId)
  const root = await repo.root(baseHash)
  const priv = root.private ? await repo.privateSet(root.private) : null
  const hashes = new Map<string, string>()
  for (const [slug, t] of Object.entries(priv?.types ?? {})) hashes.set(slug, t.schema)
  for (const [slug, t] of Object.entries(root.public.types)) hashes.set(slug, t.schema)
  const schemas: Record<string, Record<string, unknown>> = {}
  for (const [slug, h] of hashes) schemas[slug] = await repo.schema(h)
  return { schemas, metadata: root.metadata }
}

/** Check a requested base semver against the head. Null/undefined means "no check". */
function baseConflict(requested: unknown, head: { semver: string } | null): boolean {
  if (requested === null || requested === undefined) return false
  if (typeof requested !== 'string') return true
  return parseSemver(requested).semver !== (head?.semver ?? null)
}

async function commitRoute(c: Context<AppEnv>, session: SessionRow) {
  const ports = c.var.ports
  const body = await readJson(c, 64 * 1024)
  if (body instanceof Response) return body
  const wantsAsync =
    ['true', '1'].includes(c.req.query('async') ?? '') ||
    body.async === true ||
    session.recordsReceived > ASYNC_ABOVE
  if (
    !(await transition(ports, session.id, 'open', 'committing', { finalizeStartedAt: new Date() }))
  ) {
    const now = await getSession(ports, session.id)
    if (now?.status === 'committed') return c.json(now.result ?? {}, 201)
    return jsonError(c, 409, `Session is ${now?.status ?? 'gone'}`)
  }
  if (wantsAsync) {
    await ports.jobs.enqueue({ type: 'push.commit', sessionId: session.id })
    return c.json(
      {
        session_id: session.id,
        status: 'committing',
        poll: `GET ${new URL(c.req.url).pathname.replace(/\/commit$/, '')}`,
      },
      202,
    )
  }
  const outcome = await finalizeSession(ports, session.id)
  return c.json(outcome.body, outcome.status)
}

function statusBody(s: SessionRow) {
  return {
    session_id: s.id,
    status: s.status,
    records_received: s.recordsReceived,
    expires_at: s.expiresAt,
    created_at: s.createdAt,
    finalize_started_at: s.finalizeStartedAt,
    result: s.result ?? null,
    error: s.error ?? null,
  }
}

async function abandon(c: Context<AppEnv>, session: SessionRow) {
  await transition(c.var.ports, session.id, 'open', 'expired')
  return c.json({ ok: true })
}

/** Declared files the caller must upload: those the collection's base doesn't already hold. */
async function neededFiles(
  c: Context<AppEnv>,
  access: CollectionAccess,
  baseHash: string | null,
  files: string[],
): Promise<string[]> {
  if (files.length === 0) return []
  const repo = await c.var.ports.stores.forCollection(access.collection.id)
  const roots: (string | null)[] = [access.collection.publicFilesRoot]
  if (baseHash) {
    const root = await repo.root(baseHash)
    roots.push(root.public.files.root)
    if (root.private) roots.push((await repo.privateSet(root.private)).files.root)
  }
  const source = new RepoSource(fileTree, repo)
  const needed: string[] = []
  for (const h of files) {
    let have = false
    for (const r of roots) if (r && (await getEntry(source, r, h))) have = true
    if (!have) needed.push(h)
  }
  return needed
}

export function pushRoutes() {
  const app = new Hono<AppEnv>()

  // --- Delta push ---------------------------------------------------------------

  app.post('/:owner/:slug/push', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const body = await readJson(c, MAX_OPEN_BYTES)
    if (body instanceof Response) return body
    const ports = c.var.ports
    const head = await headBase(ports, access.collection.id)
    if (baseConflict(body.base, head))
      return jsonError(c, 409, 'Version conflict', { currentVersion: head?.semver ?? null })

    const base = await baseInputs(c, access.collection.id, head?.hash ?? null)
    if (body.schemas !== undefined) {
      const err = checkSchemas(body.schemas)
      if (err) return jsonError(c, 422, err)
    }
    if (
      body.metadata !== undefined &&
      body.metadata !== null &&
      typeof body.metadata !== 'object'
    ) {
      return jsonError(c, 400, '"metadata" must be an object or null')
    }
    const patch = body.metadata_patch as Record<string, unknown> | undefined
    const metadata =
      body.metadata !== undefined
        ? (body.metadata as Record<string, unknown> | null)
        : patch
          ? { ...(base.metadata ?? {}), ...patch }
          : base.metadata
    const files = (body.files ?? {}) as { add?: unknown; remove?: unknown }
    const hexList = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))
        : []
    const inputs: SessionInputs = {
      schemas: (body.schemas as SessionInputs['schemas'] | undefined) ?? base.schemas,
      metadata,
      files: { add: hexList(files.add), remove: hexList(files.remove) },
    }
    const session = await createSession(
      ports,
      {
        collectionId: access.collection.id,
        userId: c.var.principal!.userId,
        baseVersionId: head?.id ?? null,
        baseSemver: head?.semver ?? null,
        message: str(body.message),
        appId: str(body.app_id),
        actorId: str(body.actor_id),
        stripUnknownFields: body.strip_unknown_fields === true,
      },
      inputs,
    )
    return c.json({
      session_id: session.id,
      base: head?.semver ?? null,
      needed_files: await neededFiles(
        c,
        access,
        head?.hash ?? null,
        inputs.files && 'add' in inputs.files ? inputs.files.add : [],
      ),
      expires_at: session.expiresAt,
      limits: pushLimits(),
    })
  })

  app.post('/:owner/:slug/push/:sid/records', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access)
    if (session instanceof Response) return session
    // Parsed line by line as the body arrives (v2-scale-review.md S6).
    let r
    try {
      r = await ingestRecords(c.var.ports, session, readLines(c, MAX_BATCH_BYTES))
    } catch (err) {
      if (err instanceof BodyTooLarge)
        return jsonError(c, 413, `Batches are limited to ${MAX_BATCH_BYTES} bytes`)
      throw err
    }
    return r.ok
      ? c.json({ received: r.received })
      : jsonError(c, r.status, r.error, { validationErrors: r.details, totalErrors: r.total })
  })

  app.post('/:owner/:slug/push/:sid/deletes', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access)
    if (session instanceof Response) return session
    const text = await readNdjson(c)
    if (text instanceof Response) return text
    const r = await ingestDeletes(c.var.ports, session, text)
    return r.ok
      ? c.json({ received: r.received })
      : jsonError(c, r.status, r.error, { errors: r.details })
  })

  app.post('/:owner/:slug/push/:sid/commit', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access)
    if (session instanceof Response) return session
    return commitRoute(c, session)
  })

  app.get('/:owner/:slug/push/:sid', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access)
    if (session instanceof Response) return session
    return c.json(statusBody(session))
  })

  app.delete('/:owner/:slug/push/:sid', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access)
    if (session instanceof Response) return session
    return abandon(c, session)
  })

  return app
}
