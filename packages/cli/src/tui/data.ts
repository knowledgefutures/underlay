/**
 * What the terminal UI shows, read from home, the script folders and the store through the
 * library: a snapshot of the sidebar, and what each main pane needs. The UI re-reads the
 * snapshot whenever they change on disk, so an agent's or another terminal's work shows up.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { v3 } from '@underlay/protocol'

import {
  collectionStatus,
  type CollectionStatus,
  listRemote,
  type RemoteListing,
} from '../core/collections.js'
import { type Ctx, openColl, refreshCtx } from '../core/context.js'
import { type CollectionMeta, keyOf } from '../core/home.js'
import { listRuns, type RunRecord } from '../core/runs.js'
import { listScripts, type ScriptInfo } from '../core/scripts.js'
import { remoteHead } from '../core/sync.js'
import { cidOf, logOf, PAST_RESERVED, schemasAt, unpushedOf, viewOf } from '../core/versions.js'

export interface RemoteRow {
  name: string
  url: string
  signedIn: boolean
}

export interface CollectionRow {
  meta: CollectionMeta
  key: string
  status: CollectionStatus
  /** A run is writing it now. */
  running: boolean
}

export interface ScriptRow extends ScriptInfo {
  last: RunRecord | null
}

export interface Snapshot {
  remotes: RemoteRow[]
  collections: CollectionRow[]
  /** Scripts and views, from every script folder. */
  scripts: ScriptRow[]
  runs: RunRecord[]
}

export async function loadSnapshot(ctx: Ctx): Promise<Snapshot> {
  // Settings are read again: the settings screen, or someone's editor, may have changed them.
  refreshCtx(ctx)
  const runs = listRuns(ctx)
  const scripts = listScripts(ctx).map((s) => ({
    ...s,
    last: runs.find((r) => r.script === s.name) ?? null,
  }))
  const running = new Set(
    runs
      .filter((r) => r.status === 'running' || r.status === 'paused')
      .flatMap((r) => scripts.find((s) => s.name === r.script)?.writes ?? []),
  )
  const collections: CollectionRow[] = []
  for (const meta of ctx.home.collections()) {
    const key = keyOf(meta)
    collections.push({
      meta,
      key,
      status: await collectionStatus(ctx, meta),
      running: running.has(key),
    })
  }
  return {
    remotes: ctx.settings.remotes.map((r) => ({
      name: r.name,
      url: r.url,
      signedIn: ctx.env.keys.get(r.name) !== null,
    })),
    collections,
    scripts,
    runs,
  }
}

/** For each remote: your user and its listing (network; the sidebar's counts). */
export async function loadRemote(
  ctx: Ctx,
  name: string,
): Promise<RemoteListing | { error: string }> {
  try {
    return await listRemote(ctx, name)
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** How many versions each authority has that are not pulled (network). */
export async function loadBehind(ctx: Ctx, rows: CollectionRow[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  await Promise.all(
    rows.map(async (r) => {
      if (r.meta.isNew || ctx.env.keys.get(r.meta.authority) === null) return
      try {
        const n = await remoteHead(openColl(ctx, r.meta))
        if (n !== null) out[r.key] = Math.max(0, n - (r.status.remote?.number ?? 0))
      } catch {
        // Unreachable: no arrow.
      }
    }),
  )
  return out
}

export interface CollectionDetail {
  readme: string
  counts: [string, number][]
  records: number
  bytes: number
  filesHere: number
  filesTotal: number
  schemas: Record<string, unknown>
  versions: {
    number: number
    semver: string
    id: string
    message: string | null
    createdAt: string
    pushed: boolean
    run?: string
    stats?: { added: number; changed: number; removed: number }
  }[]
}

/** What the collection pane shows. Counts read key entries only, from files here. */
export async function loadCollection(ctx: Ctx, meta: CollectionMeta): Promise<CollectionDetail> {
  const c = openColl(ctx, meta)
  const readmePath = join(ctx.home.collectionDir(meta), 'README.md')
  const readme = existsSync(readmePath)
    ? readFileSync(readmePath, 'utf8')
        .replace(/^# .*\n+/, '')
        .split('\n\n')[0]!
        .trim()
    : ''
  const state = c.store.state(cidOf(c))
  const log = await logOf(c)
  const versions = log.reverse().map((s) => {
    const note = state.versions[s.id]
    return {
      number: s.commit.number,
      semver: s.commit.semver,
      id: s.id,
      message: s.commit.changes[0]?.message ?? null,
      createdAt: s.commit.createdAt,
      pushed: s.commit.number <= (state.remote?.number ?? 0),
      ...(note?.run ? { run: note.run } : {}),
      ...(note?.stats ? { stats: note.stats } : {}),
    }
  })
  let counts: [string, number][] = []
  let records = 0
  let bytes = 0
  let filesHere = 0
  let filesTotal = 0
  let schemas: Record<string, unknown> = ctx.home.schemas(meta)
  if (versions.length > 0) {
    const view = await viewOf(c)
    filesTotal = view.files.length
    for (const f of view.files) if (await c.store.fs.head(v3.recordKey(f.id))) filesHere++
    if (filesHere === filesTotal) {
      const m = await v3.counts(c.store.fs, view, { from: PAST_RESERVED })
      counts = [...m.entries()]
        .map(([t, x]) => [t, x.records] as [string, number])
        .sort((a, b) => b[1] - a[1])
      records = counts.reduce((n, [, x]) => n + x, 0)
      bytes = [...m.values()].reduce((n, x) => n + x.bytes, 0)
      schemas = { ...(await schemasAt(c.store.fs, view)), ...schemas }
    }
  }
  return { readme, counts, records, bytes, filesHere, filesTotal, schemas, versions }
}

/** A page of a collection's records, from a key on. */
export async function loadRecords(
  ctx: Ctx,
  meta: CollectionMeta,
  after: { type: string; id: string } | null,
  limit: number,
) {
  const c = openColl(ctx, meta)
  if ((await v3.headNumber(c.store.fs, meta.id)) === 0) return []
  const view = await viewOf(c)
  const dec = new TextDecoder()
  const rows = await v3.page(c.data, view, {
    ...(after ? { after } : { from: PAST_RESERVED }),
    limit,
  })
  return rows.map((r) => ({
    type: r.type,
    id: r.id,
    data: r.line
      ? JSON.stringify((JSON.parse(dec.decode(r.line)) as { data: unknown }).data)
      : '(withheld)',
  }))
}

/** The versions not yet pushed, with what each changes. */
export async function loadUnpushed(ctx: Ctx, meta: CollectionMeta) {
  const c = openColl(ctx, meta)
  const state = c.store.state(meta.id)
  return (await unpushedOf(c)).map((s) => ({ s, note: state.versions[s.id] ?? null }))
}
