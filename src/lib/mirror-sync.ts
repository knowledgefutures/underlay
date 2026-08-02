/**
 * Mirror sync logic.
 *
 * Pulls all public collections, versions, records, and files from an upstream
 * Underlay server. Designed to be called by cron or triggered manually.
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'
import { hashRecord } from './core/index.js'
import { getMirrorConfig } from './mirror-config.js'
import { headS3Object, uploadToS3 } from './s3.js'

export interface SyncResult {
  startedAt: string
  finishedAt: string
  collections: { synced: number; created: number; failed: number }
  versions: { pulled: number }
  files: { downloaded: number; skipped: number }
  errors: string[]
}

export interface SyncProgressEvent {
  type: 'start' | 'collection' | 'version' | 'file' | 'error' | 'done'
  message: string
  /** Current progress counters */
  progress: {
    collectionsTotal: number
    collectionsProcessed: number
    currentCollection?: string
    versionsPulled: number
    filesDownloaded: number
    filesSkipped: number
    errors: number
  }
}

/**
 * Global event emitter for sync progress.
 * SSE endpoint subscribes to this.
 */
export const syncEvents = new EventEmitter()
syncEvents.setMaxListeners(20)

/** Abort controller for the current sync — null if no sync running */
let activeSyncAbort: AbortController | null = null

/** ID of the currently running sync_run row */
let activeRunId: string | null = null

/** Buffered log messages for the current sync — survives SSE reconnects */
let activeRunLogs: string[] = []

/** Whether a sync is currently running */
export function isSyncRunning(): boolean {
  return activeSyncAbort !== null
}

/** Get the active run ID (for fetching logs on reconnect) */
export function getActiveRunId(): string | null {
  return activeRunId
}

/** Get buffered logs for the current run (for SSE replay) */
export function getActiveRunLogs(): string[] {
  return activeRunLogs
}

/** Stop the current sync (gracefully — finishes current item then stops) */
export function stopSync(): boolean {
  if (activeSyncAbort) {
    activeSyncAbort.abort()
    return true
  }
  return false
}

/**
 * Mark any "running" sync_runs as failed (stale from crashed processes).
 * Returns the number of rows cleaned up.
 */
export async function cleanupStaleRuns(): Promise<number> {
  const rows = await db
    .update(schema.syncRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      errors: ['Process terminated — marked as failed on cleanup'],
    })
    .where(eq(schema.syncRuns.status, 'running'))
    .returning({ id: schema.syncRuns.id })
  return rows.length
}

/** Ensure a system org exists for mirrored content */
async function ensureMirrorOrg(ownerSlug: string): Promise<string> {
  const [existing] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, ownerSlug))
    .limit(1)

  if (existing) return existing.id

  const [created] = await db
    .insert(schema.organization)
    .values({
      id: crypto.randomUUID(),
      slug: ownerSlug,
      name: ownerSlug,
    })
    .returning({ id: schema.organization.id })

  return created!.id
}

/** Ensure a schema record exists (content-addressed) */
async function ensureSchema(schemaBody: unknown): Promise<string> {
  const schemaHash = createHash('sha256').update(JSON.stringify(schemaBody)).digest('hex')

  const [existing] = await db
    .select({ id: schema.schemas.id })
    .from(schema.schemas)
    .where(eq(schema.schemas.schemaHash, schemaHash))
    .limit(1)

  if (existing) return existing.id

  const [created] = await db
    .insert(schema.schemas)
    .values({ schema: schemaBody as any, schemaHash })
    .returning({ id: schema.schemas.id })

  return created!.id
}

/** Sleep for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Fetch JSON from the upstream server with retry on 429 */
async function fetchUpstream<T>(upstream: string, path: string): Promise<T> {
  const config = getMirrorConfig()
  const url = `${upstream.replace(/\/$/, '')}${path}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers })

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10)
      const waitSec = Math.min(retryAfter + 2, 120)
      console.log(
        `[mirror-sync] Rate limited, waiting ${waitSec}s before retry (attempt ${attempt + 1}/5)`,
      )
      await sleep(waitSec * 1000)
      continue
    }

    if (!res.ok) {
      throw new Error(`Upstream ${url} returned ${res.status}: ${await res.text()}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    const body = await res.text()

    if (!contentType.includes('application/json')) {
      // Some endpoints may still return JSON without the header — try parsing
      try {
        return JSON.parse(body) as T
      } catch {
        throw new Error(
          `Upstream ${url} returned non-JSON (content-type: ${contentType}): ${body.slice(0, 200)}`,
        )
      }
    }

    try {
      return JSON.parse(body) as T
    } catch {
      throw new Error(`Upstream ${url} returned invalid JSON: ${body.slice(0, 200)}`)
    }
  }

  throw new Error(`Upstream ${url} rate limited after 5 retries`)
}

/** Download a file from upstream by hash */
async function downloadUpstreamFile(
  upstream: string,
  owner: string,
  collSlug: string,
  fileHash: string,
): Promise<Buffer> {
  const config = getMirrorConfig()
  const url = `${upstream.replace(/\/$/, '')}/api/collections/${owner}/${collSlug}/files/${fileHash}`
  const headers: Record<string, string> = {}
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers })

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10)
      const waitSec = Math.min(retryAfter + 2, 120)
      console.log(`[mirror-sync] Rate limited on file download, waiting ${waitSec}s`)
      await sleep(waitSec * 1000)
      continue
    }

    if (!res.ok) {
      throw new Error(`File download failed: ${url} → ${res.status}`)
    }
    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  throw new Error(`File download rate limited after 5 retries: ${url}`)
}

interface UpstreamCollection {
  id: string
  slug: string
  name: string
  ownerSlug: string
  ownerName: string
  createdAt: string
  updatedAt: string
}

interface UpstreamVersion {
  semver: string
  major: number
  minor: number
  patch: number
  hash: string
  message: string | null
  appId: string | null
  actorId: string | null
  recordCount: number
  fileCount: number
  totalBytes: number
  createdAt: string
}

interface UpstreamManifest {
  semver: string
  hash: string
  schemas: Record<string, string>
  records: { id: string; type: string; hash: string }[]
  files: string[]
}

interface UpstreamRecordsResponse {
  records: { id: string; type: string; data: unknown }[]
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null; total: number }
}

/**
 * Run a full mirror sync from the configured upstream.
 */
export async function runMirrorSync(trigger: 'manual' | 'cron' = 'manual'): Promise<SyncResult> {
  const config = getMirrorConfig()
  if (!config.enabled || !config.upstream) {
    throw new Error('Mirror mode is not configured')
  }

  const result: SyncResult = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    collections: { synced: 0, created: 0, failed: 0 },
    versions: { pulled: 0 },
    files: { downloaded: 0, skipped: 0 },
    errors: [],
  }

  // Create a sync_run record
  const [syncRun] = await db
    .insert(schema.syncRuns)
    .values({
      trigger,
      status: 'running',
      startedAt: new Date(),
    })
    .returning({ id: schema.syncRuns.id })

  const runId = syncRun!.id
  activeRunId = runId
  activeRunLogs = []

  const progress: SyncProgressEvent['progress'] = {
    collectionsTotal: 0,
    collectionsProcessed: 0,
    versionsPulled: 0,
    filesDownloaded: 0,
    filesSkipped: 0,
    errors: 0,
  }

  function emit(type: SyncProgressEvent['type'], message: string) {
    activeRunLogs.push(message)
    const event: SyncProgressEvent = { type, message, progress: { ...progress } }
    syncEvents.emit('progress', event)
  }

  // Set up abort controller
  activeSyncAbort = new AbortController()
  const signal = activeSyncAbort.signal

  // Log auth mode
  if (config.apiKey) {
    emit(
      'start',
      `Using API key (${config.apiKey.slice(0, 6)}…) — authenticated sync with higher rate limits`,
    )
  } else {
    emit('start', `No API key configured — using public API (stricter rate limiting)`)
  }

  const upstream = config.upstream

  // 1. Fetch all public collections from upstream
  let upstreamCollections: UpstreamCollection[]
  try {
    const collectionsResponse = await fetchUpstream<{
      collections: UpstreamCollection[]
    }>(upstream, '/api/collections?limit=100')
    upstreamCollections = collectionsResponse.collections
  } catch (err) {
    result.errors.push(`Failed to fetch collections: ${err}`)
    result.finishedAt = new Date().toISOString()
    emit('error', `Failed to fetch collections: ${err}`)
    await finishSyncRun(runId, 'failed', result)
    emit('done', 'Sync failed')
    return result
  }

  progress.collectionsTotal = upstreamCollections.length
  emit('start', `Starting sync of ${upstreamCollections.length} collections from ${upstream}`)

  // 2. For each upstream collection, sync it locally
  for (const uc of upstreamCollections) {
    // Check for abort between collections
    if (signal.aborted) {
      emit('error', 'Sync stopped by user')
      result.errors.push('Sync stopped by user')
      break
    }

    progress.currentCollection = `${uc.ownerSlug}/${uc.slug}`
    emit('collection', `Syncing ${uc.ownerSlug}/${uc.slug}...`)

    try {
      await syncCollection(upstream, uc, result, progress, emit, signal)
      result.collections.synced++
    } catch (err) {
      if (signal.aborted) {
        emit('error', 'Sync stopped by user')
        result.errors.push('Sync stopped by user')
        break
      }
      result.collections.failed++
      result.errors.push(`${uc.ownerSlug}/${uc.slug}: ${err}`)
      progress.errors++
      emit('error', `${uc.ownerSlug}/${uc.slug}: ${err}`)
    }
    progress.collectionsProcessed++
  }

  activeSyncAbort = null
  activeRunId = null
  result.finishedAt = new Date().toISOString()
  const finalStatus = signal.aborted ? 'failed' : 'completed'
  await finishSyncRun(runId, finalStatus, result)
  emit(
    'done',
    signal.aborted
      ? `Sync stopped — ${result.collections.synced} synced before stop`
      : `Sync complete — ${result.collections.synced} synced, ${result.versions.pulled} versions, ${result.files.downloaded} files`,
  )
  return result
}

/** Persist final sync results to the sync_runs row */
async function finishSyncRun(runId: string, status: 'completed' | 'failed', result: SyncResult) {
  await db
    .update(schema.syncRuns)
    .set({
      status,
      finishedAt: new Date(),
      collectionsSync: result.collections.synced,
      collectionsCreated: result.collections.created,
      collectionsFailed: result.collections.failed,
      versionsPulled: result.versions.pulled,
      filesDownloaded: result.files.downloaded,
      filesSkipped: result.files.skipped,
      errors: result.errors,
      logs: activeRunLogs,
    })
    .where(eq(schema.syncRuns.id, runId))
}

async function syncCollection(
  upstream: string,
  uc: UpstreamCollection,
  result: SyncResult,
  progress: SyncProgressEvent['progress'],
  emit: (type: SyncProgressEvent['type'], message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  // Ensure the owner org exists locally
  const organizationId = await ensureMirrorOrg(uc.ownerSlug)

  // Check if collection exists locally
  const [localColl] = await db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, uc.ownerSlug), eq(schema.collections.slug, uc.slug)))
    .limit(1)

  let collectionId: string

  if (!localColl) {
    // Create the collection locally
    const [created] = await db
      .insert(schema.collections)
      .values({
        organizationId,
        slug: uc.slug,
        name: uc.name,
        public: true,
      })
      .returning({ id: schema.collections.id })
    collectionId = created!.id
    result.collections.created++
  } else {
    collectionId = localColl.id
  }

  // Get the latest local version by semver components
  const [latestLocal] = await db
    .select({
      semver: schema.versions.semver,
      major: schema.versions.major,
      minor: schema.versions.minor,
      patch: schema.versions.patch,
    })
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.status, 'ready')))
    .orderBy(sql`major desc, minor desc, patch desc`)
    .limit(1)

  const localMajor = latestLocal?.major ?? 0
  const localMinor = latestLocal?.minor ?? 0
  const localPatch = latestLocal?.patch ?? 0

  // Fetch upstream versions we don't have
  const upstreamVersions = await fetchUpstream<UpstreamVersion[]>(
    upstream,
    `/api/collections/${uc.ownerSlug}/${uc.slug}/versions?limit=100`,
  )

  // Sort ascending to apply in order
  const newVersions = upstreamVersions
    .filter(
      (v) =>
        v.major > localMajor ||
        (v.major === localMajor && v.minor > localMinor) ||
        (v.major === localMajor && v.minor === localMinor && v.patch > localPatch),
    )
    .sort((a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch)

  if (newVersions.length === 0) return

  emit('version', `${uc.ownerSlug}/${uc.slug}: pulling ${newVersions.length} new version(s)`)

  // Pull each new version
  for (const uv of newVersions) {
    if (signal.aborted) return
    await pullVersion(upstream, uc, collectionId, uv, result, progress, emit)
    result.versions.pulled++
    progress.versionsPulled++
  }
}

async function pullVersion(
  upstream: string,
  uc: UpstreamCollection,
  collectionId: string,
  uv: UpstreamVersion,
  result: SyncResult,
  progress: SyncProgressEvent['progress'],
  emit: (type: SyncProgressEvent['type'], message: string) => void,
): Promise<void> {
  // Get the version manifest (schemas + file list)
  const manifest = await fetchUpstream<UpstreamManifest>(
    upstream,
    `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.semver}/manifest`,
  )

  // Determine which records we already have locally
  const manifestHashes = manifest.records.map((r) => r.hash)
  let neededHashes: string[] = manifestHashes
  if (manifestHashes.length > 0) {
    const CHUNK = 500
    const existingSet = new Set<string>()
    for (let i = 0; i < manifestHashes.length; i += CHUNK) {
      const chunk = manifestHashes.slice(i, i + CHUNK)
      const rows = await db
        .select({ hash: schema.recordObjects.hash })
        .from(schema.recordObjects)
        .where(inArray(schema.recordObjects.hash, chunk))
      for (const r of rows) existingSet.add(r.hash)
    }
    neededHashes = manifestHashes.filter((h) => !existingSet.has(h))
  }

  // Fetch and insert missing records in batches instead of accumulating all in memory
  const BATCH_SIZE = 500
  let fetchedCount = 0
  if (neededHashes.length > 0) {
    const insertRecordBatch = async (records: { id: string; type: string; data: unknown }[]) => {
      if (records.length === 0) return
      const rows = records.map((r) => {
        const { hash, canonical } = hashRecord({ id: r.id, type: r.type, data: r.data })
        return {
          hash,
          recordId: r.id,
          type: r.type,
          data: r.data as any,
          private: false,
          size: Buffer.byteLength(canonical, 'utf8'),
        }
      })
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE)
        await db.insert(schema.recordObjects).values(chunk).onConflictDoNothing()
      }
      fetchedCount += records.length
    }

    const fetchAllPaginated = async () => {
      let cursor: string | null = null
      let hasMore = true
      while (hasMore) {
        const recordsPath: string = cursor
          ? `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.semver}/records?limit=1000&after=${cursor}`
          : `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.semver}/records?limit=1000`
        const page = await fetchUpstream<UpstreamRecordsResponse>(upstream, recordsPath)
        await insertRecordBatch(page.records)
        hasMore = page.pagination.hasMore
        cursor = page.pagination.nextCursor
      }
    }

    try {
      const config = getMirrorConfig()
      const batchUrl = `${upstream.replace(/\/$/, '')}/api/records/batch`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

      const CHUNK_SIZE = 500
      for (let i = 0; i < neededHashes.length; i += CHUNK_SIZE) {
        const hashChunk = neededHashes.slice(i, i + CHUNK_SIZE)
        const res = await fetch(batchUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ hashes: hashChunk }),
        })

        if (res.ok) {
          const text = await res.text()
          const records = text
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as { id: string; type: string; data: unknown })
          await insertRecordBatch(records)
        } else {
          await fetchAllPaginated()
          break
        }
      }
    } catch {
      await fetchAllPaginated()
    }
    emit(
      'version',
      `${uc.ownerSlug}/${uc.slug} ${uv.semver}: fetched ${fetchedCount} records (${manifestHashes.length - neededHashes.length} already local)`,
    )
  }

  // Pull files — track which hashes succeed for version_files FK
  const availableFileHashes = new Set<string>()
  for (const fileHash of manifest.files) {
    const storageKey = `files/${fileHash.slice(0, 2)}/${fileHash.slice(2, 4)}/${fileHash}`

    // Check if file already exists in our S3
    const exists = await headS3Object(storageKey)
    if (exists) {
      // File is in S3 — just ensure the DB row exists
      await db
        .insert(schema.files)
        .values({
          hash: fileHash,
          size: 0, // will be correct from S3 metadata if needed
          mimeType: 'application/octet-stream',
          storageKey,
        })
        .onConflictDoNothing()

      availableFileHashes.add(fileHash)
      result.files.skipped++
      progress.filesSkipped++
      continue
    }

    // Download from upstream
    try {
      const buffer = await downloadUpstreamFile(upstream, uc.ownerSlug, uc.slug, fileHash)

      // Verify hash
      const computedHash = createHash('sha256').update(buffer).digest('hex')
      if (computedHash !== fileHash) {
        result.errors.push(`File hash mismatch for ${fileHash}: computed ${computedHash}`)
        continue
      }

      // Upload to our S3
      await uploadToS3(storageKey, buffer)

      // Upsert into files table
      await db
        .insert(schema.files)
        .values({
          hash: fileHash,
          size: buffer.length,
          mimeType: 'application/octet-stream',
          storageKey,
        })
        .onConflictDoNothing()

      availableFileHashes.add(fileHash)
      result.files.downloaded++
      progress.filesDownloaded++
      emit('file', `Downloaded file ${fileHash.slice(0, 8)}… (${buffer.length} bytes)`)
    } catch (err) {
      result.errors.push(`File ${fileHash}: ${err}`)
      progress.errors++
    }
  }

  // Fetch version detail to get schema bodies
  const versionDetail = await fetchUpstream<{
    semver: string
    hash: string
    schemas: Record<string, unknown>
    metadata?: unknown
  }>(upstream, `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.semver}`).catch(
    () => null,
  )

  // Record objects already inserted during fetch. Create version with status='creating',
  // insert version_records in batches outside transaction, then mark 'ready'.
  const [newVersion] = await db
    .insert(schema.versions)
    .values({
      collectionId,
      semver: uv.semver,
      major: uv.major,
      minor: uv.minor,
      patch: uv.patch,
      hash: uv.hash,
      message: uv.message,
      metadata: versionDetail?.metadata ?? null,
      appId: uv.appId,
      actorId: uv.actorId,
      recordCount: manifest.records.length,
      fileCount: manifest.files.length,
      typeCounts: manifest.records.reduce<Record<string, number>>((acc, r) => {
        acc[r.type] = (acc[r.type] ?? 0) + 1
        return acc
      }, {}),
      totalBytes: uv.totalBytes,
      status: 'creating',
    })
    .returning({ id: schema.versions.id })

  const versionId = newVersion!.id

  try {
    if (versionDetail?.schemas) {
      for (const [slug, schemaBody] of Object.entries(versionDetail.schemas)) {
        const schemaId = await ensureSchema(schemaBody)
        await db.insert(schema.versionSchemas).values({ versionId, slug, schemaId })
      }
    }

    for (let i = 0; i < manifest.records.length; i += BATCH_SIZE) {
      const batch = manifest.records.slice(i, i + BATCH_SIZE)
      await db.insert(schema.versionRecords).values(
        batch.map((r) => ({
          versionId,
          recordHash: r.hash,
          recordId: r.id,
          type: r.type,
        })),
      )
    }

    const fileHashList = manifest.files.filter((h) => availableFileHashes.has(h))
    for (let i = 0; i < fileHashList.length; i += BATCH_SIZE) {
      const batch = fileHashList.slice(i, i + BATCH_SIZE)
      await db
        .insert(schema.versionFiles)
        .values(batch.map((hash) => ({ versionId, fileHash: hash })))
    }

    await db
      .update(schema.versions)
      .set({ status: 'ready' })
      .where(eq(schema.versions.id, versionId))
  } catch (err) {
    await db.delete(schema.versions).where(eq(schema.versions.id, versionId))
    throw err
  }
}

/**
 * Test connectivity to an upstream server.
 */
export async function testUpstreamConnection(upstream: string): Promise<{
  ok: boolean
  version?: string
  collectionCount?: number
  error?: string
}> {
  try {
    const health = await fetchUpstream<{ status: string; timestamp: string }>(
      upstream,
      '/api/health',
    )

    if (health.status !== 'ok') {
      return { ok: false, error: 'Upstream health check failed' }
    }

    const allColls = await fetchUpstream<unknown[]>(upstream, '/api/collections?limit=100')

    return {
      ok: true,
      version: 'unknown',
      collectionCount: allColls.length,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Get the current sync status for all mirrored collections.
 */
export async function getMirrorStatus(): Promise<{
  upstream: string
  nodeName: string
  syncSchedule: string
  collections: {
    ownerSlug: string
    slug: string
    name: string
    localVersion: string
    updatedAt: string
  }[]
  lastSyncAt: string | null
}> {
  const config = getMirrorConfig()

  const collections = await db
    .select({
      ownerSlug: schema.organization.slug,
      slug: schema.collections.slug,
      name: schema.collections.name,
      updatedAt: schema.collections.updatedAt,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(eq(schema.collections.public, true))

  // Get latest version for each collection
  const collsWithVersions = await Promise.all(
    collections.map(async (c) => {
      const [latest] = await db
        .select({ semver: schema.versions.semver })
        .from(schema.versions)
        .innerJoin(schema.collections, eq(schema.versions.collectionId, schema.collections.id))
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(
          and(
            eq(schema.organization.slug, c.ownerSlug),
            eq(schema.collections.slug, c.slug),
            eq(schema.versions.status, 'ready'),
          ),
        )
        .orderBy(sql`major desc, minor desc, patch desc`)
        .limit(1)

      return {
        ownerSlug: c.ownerSlug,
        slug: c.slug,
        name: c.name,
        localVersion: latest?.semver ?? '0.0.0',
        updatedAt: c.updatedAt.toISOString(),
      }
    }),
  )

  return {
    upstream: config.upstream,
    nodeName: config.nodeName,
    syncSchedule: config.syncSchedule,
    collections: collsWithVersions,
    lastSyncAt: await getLastSyncAt(),
  }
}

/** Get the most recent completed sync timestamp */
async function getLastSyncAt(): Promise<string | null> {
  const [row] = await db
    .select({ finishedAt: schema.syncRuns.finishedAt })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.status, 'completed'))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1)
  return row?.finishedAt?.toISOString() ?? null
}

/** Get sync run history (most recent first) */
export async function getSyncHistory(limit = 20): Promise<
  {
    id: string
    trigger: string
    status: string
    startedAt: string
    finishedAt: string | null
    collectionsSynced: number
    collectionsCreated: number
    collectionsFailed: number
    versionsPulled: number
    filesDownloaded: number
    filesSkipped: number
    errors: string[]
    logs: string[]
  }[]
> {
  const rows = await db
    .select()
    .from(schema.syncRuns)
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    collectionsSynced: r.collectionsSync,
    collectionsCreated: r.collectionsCreated,
    collectionsFailed: r.collectionsFailed,
    versionsPulled: r.versionsPulled,
    filesDownloaded: r.filesDownloaded,
    filesSkipped: r.filesSkipped,
    errors: (r.errors as string[]) ?? [],
    logs: (r.logs as string[]) ?? [],
  }))
}
