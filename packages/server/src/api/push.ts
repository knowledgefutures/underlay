/**
 * Push routes, mounted at /api/collections.
 *
 * Delta push (new):
 *   POST   /:owner/:slug/push                      open a session against a base
 *   POST   /:owner/:slug/push/:sid/records         NDJSON {id,type,data,private?}
 *   POST   /:owner/:slug/push/:sid/deletes         NDJSON {type,id}
 *   POST   /:owner/:slug/push/:sid/commit          ?async=true for a job
 *   GET    /:owner/:slug/push/:sid                 status (and result after an async commit)
 *   DELETE /:owner/:slug/push/:sid                 abandon
 *
 * Negotiate (v1 compatibility, same paths and shapes as v1):
 *   POST   /:owner/:slug/versions/negotiate
 *   POST   /:owner/:slug/versions/negotiate/:sid/manifest
 *   POST   /:owner/:slug/versions/negotiate/:sid/records
 *   POST   /:owner/:slug/versions/negotiate/:sid/commit
 *   GET    /:owner/:slug/versions/negotiate/:sid
 *   DELETE /:owner/:slug/versions/negotiate/:sid
 */
import { checkSchema, fileTree, getEntry, RepoSource } from '@underlay/protocol'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { registerJob } from '../jobs.js'
import {
  headBase,
  ingestDeletes,
  ingestRecords,
  MAX_BATCH_BYTES,
  prepareRecords,
  versionBase,
} from '../push/delta.js'
import { finalizeSession } from '../push/finalize.js'
import {
  baseTrees,
  type ManifestLine,
  neededOf,
  parseManifestLine,
  withLegacyHash,
} from '../push/negotiate.js'
import { writeRun } from '../push/runs.js'
import {
  createSession,
  getSession,
  loadInputs,
  nextRunSeq,
  recordRun,
  type SessionInputs,
  type SessionRow,
  transition,
} from '../push/session.js'
import { parseSemver } from '../versions/semver.js'
import { type CollectionAccess, jsonError, requireCollection } from './access.js'
import { BodyTooLarge, readJson, readText } from './body.js'

const MAX_OPEN_BYTES = 8 * 1024 * 1024
const MAX_MANIFEST_CHUNK = 50_000
const MAX_INLINE_MANIFEST = 50_000
/** Commits above this many uploaded records (or negotiate manifest entries) run as a job even without ?async. */
const ASYNC_ABOVE = 100_000
/**
 * The largest snapshot a negotiate push may send. Its commit diffs the whole
 * snapshot in one job, about 5 minutes of CPU at this size (v2-limits-and-costs.md,
 * "Records per collection"; v2-scale-review.md S4). Delta pushes commit in
 * parallel units and have no such ceiling.
 */
export const negotiateLimits = { maxEntries: 10_000_000 }
const TOO_BIG_FOR_NEGOTIATE = () =>
  `Negotiate pushes are limited to ${negotiateLimits.maxEntries.toLocaleString('en-US')} records, the most one commit job can diff. Push larger collections with a delta push (POST …/push: upserts and deletes against the head), which commits in parallel.`

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
  kind: SessionRow['kind'],
): Promise<SessionRow | Response> {
  const session = await getSession(c.var.ports, c.req.param('sid') ?? '')
  if (!session || session.collectionId !== access.collection.id || session.kind !== kind) {
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
    session.recordsReceived > ASYNC_ABOVE ||
    session.manifestReceived > ASYNC_ABOVE
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
    total_records: s.manifestReceived,
    needed_records: Math.max(0, s.manifestNeeded - s.recordsReceived),
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
        kind: 'delta',
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
    })
  })

  app.post('/:owner/:slug/push/:sid/records', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'delta')
    if (session instanceof Response) return session
    const text = await readNdjson(c)
    if (text instanceof Response) return text
    const r = await ingestRecords(c.var.ports, session, text)
    return r.ok
      ? c.json({ received: r.received })
      : jsonError(c, r.status, r.error, { validationErrors: r.details, totalErrors: r.total })
  })

  app.post('/:owner/:slug/push/:sid/deletes', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'delta')
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
    const session = await ownSession(c, access, 'delta')
    if (session instanceof Response) return session
    return commitRoute(c, session)
  })

  app.get('/:owner/:slug/push/:sid', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'delta')
    if (session instanceof Response) return session
    return c.json(statusBody(session))
  })

  app.delete('/:owner/:slug/push/:sid', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'delta')
    if (session instanceof Response) return session
    return abandon(c, session)
  })

  // --- Negotiate (v1 compatibility) ----------------------------------------------------

  /** Validate manifest entries and store them as a run; returns the needed hashes. */
  const ingestManifest = async (
    c: Context<AppEnv>,
    session: SessionRow,
    entries: ManifestLine[],
  ) => {
    const ports = c.var.ports
    const inputs = await loadInputs(ports, session.id)
    for (const m of entries) {
      if (!inputs.schemas[m.type])
        throw new ManifestError(`No schema defined for record type "${m.type}"`)
    }
    // Against what the commit will diff against (commitNegotiateSession): the
    // session's base when it named one, otherwise whatever the head is.
    const base =
      session.baseSemver !== null
        ? await versionBase(ports, session.baseVersionId)
        : await headBase(ports, session.collectionId)
    const trees = await baseTrees(ports, session.collectionId, base?.hash ?? null)
    const needed = await neededOf(trees, entries)
    const seq = await nextRunSeq(ports, session.id)
    if (seq === null) throw new ManifestError('Session is not open', 409)
    const run = entries.map((m) => ({
      t: m.type,
      k: m.id,
      h: m.hash,
      ...(m.private ? { p: true } : {}),
    }))
    const index = await writeRun(ports.stores.internal, session.id, seq, run)
    await recordRun(ports, session.id, 'manifest', index, {
      manifest: entries.length,
      needed: needed.length,
    })
    return needed
  }

  app.post('/:owner/:slug/versions/negotiate', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const body = await readJson(c, 64 * 1024 * 1024)
    if (body instanceof Response) return body
    const err = checkSchemas(body.schemas)
    if (err) return jsonError(c, 422, err)
    const ports = c.var.ports
    const head = await headBase(ports, access.collection.id)
    if (baseConflict(body.base_version, head)) {
      return jsonError(c, 409, 'Version conflict', { currentVersion: head?.semver ?? null })
    }
    const inline = Array.isArray(body.manifest) ? body.manifest : []
    const chunked = body.manifest_expected !== undefined
    if (chunked && inline.length > 0) {
      return jsonError(
        c,
        400,
        'Send either an inline `manifest` or `manifest_expected` with chunked upload, not both.',
      )
    }
    if (inline.length > MAX_INLINE_MANIFEST) {
      return jsonError(
        c,
        413,
        `Inline manifests are limited to ${MAX_INLINE_MANIFEST} entries; set manifest_expected and upload chunks.`,
      )
    }
    if (chunked && Number(body.manifest_expected) > negotiateLimits.maxEntries) {
      return jsonError(c, 413, TOO_BIG_FOR_NEGOTIATE())
    }
    const entries: ManifestLine[] = []
    for (const m of inline) {
      const parsed = parseManifestLine(m)
      if (typeof parsed === 'string') return jsonError(c, 400, `Invalid manifest entry: ${parsed}`)
      entries.push(parsed)
    }
    const files = Array.isArray(body.files)
      ? body.files.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))
      : []
    const session = await createSession(
      ports,
      {
        collectionId: access.collection.id,
        userId: c.var.principal!.userId,
        kind: 'negotiate',
        baseVersionId: head?.id ?? null,
        baseSemver:
          typeof body.base_version === 'string' ? parseSemver(body.base_version).semver : null,
        message: str(body.message),
        appId: str(body.app_id),
        actorId: str(body.actor_id),
        stripUnknownFields: body.strip_unknown_fields === true,
        manifestExpected: chunked ? Number(body.manifest_expected) : null,
      },
      {
        schemas: body.schemas as SessionInputs['schemas'],
        metadata: (body.metadata as Record<string, unknown> | undefined) ?? null,
        files: { all: files },
      },
    )
    const neededFilesList = await neededFiles(c, access, head?.hash ?? null, files)
    if (chunked) {
      return c.json({
        session_id: session.id,
        manifest_expected: session.manifestExpected,
        manifest_received: 0,
        needed_files: neededFilesList,
        total_files: files.length,
        already_have_files: files.length - neededFilesList.length,
        next: `POST .../versions/negotiate/${session.id}/manifest`,
      })
    }
    let needed: string[] = []
    try {
      if (entries.length > 0) needed = await ingestManifest(c, session, entries)
    } catch (err) {
      if (err instanceof ManifestError) return jsonError(c, err.status, err.message)
      throw err
    }
    return c.json({
      session_id: session.id,
      needed_records: needed,
      needed_files: neededFilesList,
      total_records: entries.length,
      total_files: files.length,
      already_have_records: entries.length - needed.length,
      already_have_files: files.length - neededFilesList.length,
    })
  })

  app.post('/:owner/:slug/versions/negotiate/:sid/manifest', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'negotiate')
    if (session instanceof Response) return session
    if (session.manifestExpected === null) {
      return jsonError(
        c,
        400,
        'This session was opened with an inline manifest. Pass `manifest_expected` at negotiate time to upload the manifest in chunks.',
      )
    }
    const text = await readNdjson(c)
    if (text instanceof Response) return text
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length > MAX_MANIFEST_CHUNK)
      return jsonError(
        c,
        400,
        `Chunk too large. Maximum ${MAX_MANIFEST_CHUNK} manifest entries per request.`,
      )
    if (session.manifestReceived + lines.length > negotiateLimits.maxEntries) {
      return jsonError(c, 413, TOO_BIG_FOR_NEGOTIATE())
    }
    const entries: ManifestLine[] = []
    for (const line of lines) {
      let v: unknown
      try {
        v = JSON.parse(line)
      } catch {
        return jsonError(c, 400, `Invalid JSONL line: ${line.slice(0, 100)}`)
      }
      const parsed = parseManifestLine(v)
      if (typeof parsed === 'string')
        return jsonError(c, 400, `Invalid manifest entry: ${line.slice(0, 100)}`, {
          details: [parsed],
        })
      entries.push(parsed)
    }
    try {
      const needed = await ingestManifest(c, session, entries)
      const now = await getSession(c.var.ports, session.id)
      return c.json({
        received: entries.length,
        needed_records: needed,
        manifest_received: now!.manifestReceived,
        manifest_expected: session.manifestExpected,
      })
    } catch (err) {
      if (err instanceof ManifestError) return jsonError(c, err.status, err.message)
      throw err
    }
  })

  app.post('/:owner/:slug/versions/negotiate/:sid/records', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'negotiate')
    if (session instanceof Response) return session
    if (session.status !== 'open') return jsonError(c, 409, `Session is ${session.status}`)
    const text = await readNdjson(c)
    if (text instanceof Response) return text
    const ports = c.var.ports
    const inputs = await loadInputs(ports, session.id)
    const prepared = await prepareRecords(ports, session.collectionId, inputs, text, {
      stripUnknownFields: session.stripUnknownFields,
    })
    if ('errors' in prepared) {
      return jsonError(c, 422, 'Schema validation failed', {
        validationErrors: prepared.errors,
        totalErrors: prepared.total,
      })
    }
    if (prepared.entries.length === 0) return jsonError(c, 400, 'Empty batch')
    // Keep the format 1 hash next to the v2 one, so a v1 manifest entry matches either.
    const datas = new Map(
      text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const r = JSON.parse(l) as { id: string; type: string; data: unknown }
          return [`${r.type}\u0000${r.id}`, r.data] as const
        }),
    )
    const entries = prepared.entries.map((e) => withLegacyHash(e, datas.get(`${e.t}\u0000${e.k}`)))
    const seq = await nextRunSeq(ports, session.id)
    if (seq === null) return jsonError(c, 409, 'Session is not open')
    const index = await writeRun(ports.stores.internal, session.id, seq, entries)
    await recordRun(ports, session.id, 'records', index, { records: entries.length })
    const now = await getSession(ports, session.id)
    return c.json({
      received: entries.length,
      remaining: Math.max(0, now!.manifestNeeded - now!.recordsReceived),
    })
  })

  app.post('/:owner/:slug/versions/negotiate/:sid/commit', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'negotiate')
    if (session instanceof Response) return session
    return commitRoute(c, session)
  })

  app.get('/:owner/:slug/versions/negotiate/:sid', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'negotiate')
    if (session instanceof Response) return session
    return c.json(statusBody(session))
  })

  app.delete('/:owner/:slug/versions/negotiate/:sid', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    const session = await ownSession(c, access, 'negotiate')
    if (session instanceof Response) return session
    return abandon(c, session)
  })

  return app
}

class ManifestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message)
  }
}
