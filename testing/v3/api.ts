/**
 * The Crossref sample through the API (v3-deploy-plan.md, Phase 2's exit): the bench's own
 * build of the sorted dump's first `files` files, sent to a v3 collection on a deployed
 * server the way a client does (presigned URLs, then a commit the server verifies and
 * lands), then daily changes the same way, then reads through the API.
 *
 *   UL_KEY=… node dist/bench.mjs api-crossref --to https://staging.underlay.org \
 *     --collection qa-review-2/v3-crossref --files 2000 --days 6
 *
 * Builds happen here, on the bench's workers; everything else is the server's.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fileStore, v3 } from '../../packages/protocol/src/index.js'
import { log, measure, refOf, round, runWorker, summary, type WorkerReport } from './lib.js'
import { type CrossrefOptions, crossrefDayRows, dumpFiles, type Result } from './scenarios.js'
import type { BuildDumpSpec } from './workers.js'
import { CROSSREF_DAILY, storeOf, type World } from './world.js'

export interface ApiTarget {
  base: string
  collection: string
  key: string
  /** Files sent at once. */
  parallel: number
}

function client(t: ApiTarget) {
  const api = `${t.base.replace(/\/$/, '')}/api/collections/${t.collection}`
  let calls = 0
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, any>> => {
    for (let attempt = 0; ; attempt++) {
      calls++
      const res = await fetch(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).catch((err: unknown) => ({ ok: false, status: 0, err }) as never)
      if ((res.status === 0 || res.status === 429 || res.status >= 500) && attempt < 6) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        continue
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, any>
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`)
      return json
    }
  }
  const timed = async (path: string) => {
    const t0 = performance.now()
    const res = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${t.key}` } })
    const bytes = (await res.arrayBuffer()).byteLength
    return { status: res.status, ms: performance.now() - t0, bytes }
  }
  return { call, timed, calls: () => calls }
}

/** Send built files as one upload and wait for it to land; times for each part. */
async function sendUpload(
  t: ApiTarget,
  dir: string,
  session: string,
  files: v3.FileRef[],
  message: string,
): Promise<Result> {
  const { call } = client(t)
  const t0 = performance.now()
  const opened = await call('POST', '/uploads', { message })
  const id = opened.upload_id as string
  let bytes = 0
  const queue = [...files]
  await Promise.all(
    Array.from({ length: Math.min(t.parallel, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const body = await readFile(join(dir, v3.uploadKey(session, f.id)))
        bytes += body.byteLength
        for (let attempt = 0; ; attempt++) {
          try {
            const target = await call('POST', `/uploads/${id}/files`, {
              id: f.id,
              size: body.byteLength,
            })
            if (target.method === 'PUT') {
              const res = await fetch(target.url, { method: 'PUT', body })
              if (!res.ok) throw new Error(`PUT ${res.status}`)
            } else {
              const parts: { n: number; etag: string }[] = []
              for (const p of target.parts as { n: number; url: string }[]) {
                const from = (p.n - 1) * target.part_bytes
                const res = await fetch(p.url, {
                  method: 'PUT',
                  body: body.subarray(from, from + target.part_bytes),
                })
                if (!res.ok) throw new Error(`PUT part ${p.n}: ${res.status}`)
                parts.push({ n: p.n, etag: res.headers.get('etag') ?? '' })
              }
              await call('POST', `/uploads/${id}/files/${f.id}/complete`, {
                upload_id: target.upload_id,
                parts,
              })
            }
            break
          } catch (err) {
            if (attempt >= 4) throw err
            log(`upload: ${f.id} failed (${String(err)}), again`)
            await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
          }
        }
      }
    }),
  )
  const sent = performance.now()
  // A small commit is answered with its result; a large one is polled, soon at first.
  let s: Record<string, any> = await call('POST', `/uploads/${id}/commit`, { files })
  let lastLog = 0
  for (let wait = 1000; ; wait = Math.min(5000, wait * 2)) {
    if (s.status === 'committed' || s.status === 'failed' || s.status === 'open') break
    await new Promise((r) => setTimeout(r, wait))
    s = await call('GET', `/uploads/${id}`)
    if (performance.now() - lastLog > 60_000) {
      lastLog = performance.now()
      log(`upload ${id}: ${s.status}, ${s.files_verified} of ${s.files_named} verified`)
    }
  }
  const done = performance.now()
  if (s.status !== 'committed')
    throw new Error(`upload ${id} ${s.status}: ${JSON.stringify(s.error)}`)
  return {
    upload: id,
    files: files.length,
    storedBytes: bytes,
    lineBytes: files.reduce((n, f) => n + f.bytes, 0),
    entries: files.reduce((n, f) => n + f.entries, 0),
    sendSeconds: round((sent - t0) / 1000, 1),
    sendMbPerSecond: round(bytes / 1024 ** 2 / ((sent - t0) / 1000), 1),
    serverSeconds: round((done - sent) / 1000, 1),
    result: s.result,
  }
}

/** The sample: build here, send through the API, and commit. */
export async function apiCrossrefLoad(w: World, o: CrossrefOptions, t: ApiTarget): Promise<Result> {
  const store = storeOf(w, 'none')
  const plan = JSON.parse(await readFile(o.plan, 'utf8')) as { types: string[] }
  const { files } = dumpFiles(o)
  const parts = Math.min(w.workers, files.length)
  const per = Math.ceil(files.length / parts)
  const session = v3.newSession()
  log(`api-crossref: building ${files.length} dump files in ${parts} parts`)
  const build = await measure(store, () =>
    Promise.all(
      Array.from({ length: parts }, (_, p) =>
        runWorker<WorkerReport & { records: number; files: v3.FileRef[] }>('build-dump', {
          session,
          storeDir: w.storeDir,
          latency: 'none',
          dataDir: o.dataDir,
          files,
          start: p * per,
          end: Math.min(files.length, (p + 1) * per),
          first: p === 0,
          schemaTypes: p === 0 ? plan.types : null,
          cutBytes: w.cutBytes,
        } satisfies BuildDumpSpec),
      ),
    ),
  )
  const refs = build.value.flatMap((b) => b.files)
  const records = build.value.reduce((n, b) => n + b.records, 0)
  log(
    `api-crossref: built ${refs.length} files, ${records} records in ${build.m.seconds}s; sending`,
  )
  const sent = await sendUpload(t, w.storeDir, session, refs, 'Crossref sample, through the API')
  log('api-crossref: committed', sent)
  return {
    records,
    buildSeconds: build.m.seconds,
    ...sent,
    keys: refs.map((f) => f.first).filter(Boolean),
  }
}

/** Days of the bench's Crossref changes, each built here and sent through the API. */
export async function apiCrossrefDays(
  w: World,
  o: CrossrefOptions,
  t: ApiTarget,
  days: number,
): Promise<Result> {
  const { all, files } = dumpFiles(o)
  const changes = Math.round((CROSSREF_DAILY * files.length) / all.length)
  const rows: Result[] = []
  for (let day = 1; day <= days; day++) {
    const session = v3.newSession()
    const local = fileStore(w.storeDir)
    const t0 = performance.now()
    const sorted = v3.sortRows(
      crossrefDayRows(o, files, day, changes, 'api'),
      fileStore(join(w.storeDir, 'tmp-sort')),
    )
    const built = await v3.buildFiles(sorted, v3.uploadTarget(local, session))
    const buildSeconds = round((performance.now() - t0) / 1000, 1)
    const sent = await sendUpload(t, w.storeDir, session, built.map(refOf), `day ${day}`)
    rows.push({ day, buildSeconds, ...sent })
    log(`api-crossref: day ${day}`, rows[rows.length - 1])
  }
  return { days, changesPerDay: changes, rows }
}

/** Reads through the API: one record across the key space, pages, a diff, the manifest. */
export async function apiReads(
  t: ApiTarget,
  keys: [string, string][],
  label: string,
): Promise<Result> {
  const { timed } = client(t)
  const sample = keys
    .filter((_, i) => i % Math.max(1, Math.floor(keys.length / 100)) === 0)
    .slice(0, 100)
  const one: number[] = []
  let missing = 0
  for (const [type, id] of sample) {
    if (type.startsWith('$')) continue
    const r = await timed(
      `/versions/latest/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    )
    if (r.status === 200) one.push(r.ms)
    else missing++
  }
  const page = await timed('/versions/latest/records?type=journal-article&limit=50')
  const deep = await timed('/versions/latest/records?type=journal-article&limit=50&offset=500000')
  const diff = await timed('/versions/latest/diff?limit=500')
  const manifest = await timed('/versions/latest/manifest?limit=1000')
  const detail = await timed('/versions/latest')
  const out = {
    label,
    oneRecordMs: summary(one.sort((a, b) => a - b)),
    missing,
    pageOf50Ms: round(page.ms),
    pageAtOffset500kMs: round(deep.ms),
    diffPageOf500Ms: round(diff.ms),
    manifestPageMs: round(manifest.ms),
    versionMs: round(detail.ms),
    statuses: [page.status, deep.status, diff.status, manifest.status, detail.status],
  }
  log(`api-crossref reads ${label}`, out)
  return out
}
