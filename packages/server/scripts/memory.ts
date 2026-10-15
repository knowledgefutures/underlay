/**
 * Memory of every push job on large records: uploads, compactions, the commit's
 * planning, units and assembly, and indexing, run in this process on records
 * shaped like Crossref works (about 6.5 KB, non-ASCII text, long reference
 * lists). Prints, per job type, how many ran and the most live memory one held
 * above where it started: JS heap plus array buffers, after a forced GC, sampled
 * every few storage operations. Stored objects are on disk (a file store), and
 * the shared cache is off, as the Cache API sits outside a Worker's isolate; the
 * isolate's memory cache is the bulk Worker's 8 MB.
 *
 *   node --expose-gc --import tsx scripts/memory.ts [options]
 *
 *   --records N        records in the first push (default 90000, about 600 MB)
 *   --update N         records the second push changes, spread over the first's (default 20000)
 *   --commit-runs N    compactConfig.commitRuns (default 4, so the commit compacts first)
 *   --piece-mb N       compactConfig.pieceBytes in MB (default 128, so compactions split)
 *   --unit-mb N        parallelConfig.unitBytes and aboveBytes in MB (default: production's)
 *   --sample N         storage operations between samples (default 25)
 *
 * Budgets not named here are the production ones (parallelConfig, runConfig).
 * A Worker has 128 MB per isolate, shared by the invocations it runs at once.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ed25519Signer,
  fileStore,
  generateSigningKey,
  memoryStore,
  newSalt,
  noCache,
  type Store,
} from '@underlay/protocol'
import { and, asc, eq, lte, sql } from 'drizzle-orm'

import '../src/handlers.js'
import { createApp } from '../src/app.js'
import { D1_MAX_BOUND_PARAMS, openNodeDb } from '../src/db/node.js'
import * as schema from '../src/db/schema.js'
import { BULK_JOBS, runJob, SqliteJobs } from '../src/jobs.js'
import type { JobMessage, Ports } from '../src/ports.js'
import { compactConfig } from '../src/push/compact.js'
import { MAX_BATCH_BYTES, MAX_BATCH_LINES } from '../src/push/delta.js'
import { parallelConfig } from '../src/push/parallel.js'
import { createStores } from '../src/stores.js'

const args = process.argv.slice(2)
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : def
}
const RECORDS = opt('records', 90_000)
const UPDATE = opt('update', 20_000)
const SAMPLE = opt('sample', 25)
compactConfig.commitRuns = opt('commit-runs', 4)
compactConfig.pieceBytes = opt('piece-mb', 128) * 1024 * 1024
if (args.includes('--unit-mb'))
  parallelConfig.unitBytes = parallelConfig.aboveBytes = opt('unit-mb', 0) * 1024 * 1024

const gc = (globalThis as { gc?: () => void }).gc
if (!gc) {
  console.error('Run with node --expose-gc --import tsx scripts/memory.ts')
  process.exit(2)
}
const MB = 1024 * 1024
let parts = { heap: 0, buffers: 0 }
const live = () => {
  gc()
  const m = process.memoryUsage()
  parts = { heap: m.heapUsed, buffers: m.arrayBuffers }
  return m.heapUsed + m.arrayBuffers
}

// --- Sampling ------------------------------------------------------------------------

let ops = 0
let peak = 0
let peakParts = { heap: 0, buffers: 0 }
const sample = () => {
  if (++ops % SAMPLE !== 0) return
  const m = live()
  if (m > peak) {
    peak = m
    peakParts = parts
  }
}
/** A store that samples memory every SAMPLE operations. */
function sampled(store: Store): Store {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (
        typeof v !== 'function' ||
        !['get', 'put', 'head', 'list', 'delete'].includes(String(prop))
      )
        return v
      return async (...a: unknown[]) => {
        sample()
        const out = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a)
        sample()
        return out
      }
    },
  })
}

const stats = new Map<
  string,
  { n: number; peak: number; heap: number; buffers: number; ms: number }
>()
async function measure(label: string, fn: () => Promise<unknown>) {
  const base = live()
  const baseParts = parts
  peak = base
  peakParts = parts
  const t = Date.now()
  await fn()
  sample()
  const s = stats.get(label) ?? { n: 0, peak: 0, heap: 0, buffers: 0, ms: 0 }
  s.n++
  if (peak - base > s.peak) {
    s.peak = peak - base
    s.heap = peakParts.heap - baseParts.heap
    s.buffers = peakParts.buffers - baseParts.buffers
  }
  s.ms += Date.now() - t
  stats.set(label, s)
}

// --- Records shaped like Crossref works ------------------------------------------------

// mulberry32: small, seedable, and good enough that ids don't collide.
let seed = 1
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!
const WORDS = [
  'analysis',
  'protein',
  'Étude',
  'über',
  'Gesellschaft',
  'climate',
  'résumé',
  'quantum',
  '研究',
  'データ',
  'модель',
  'ação',
  'network',
  'learning',
  'cell',
  'cancer',
  'São',
  'Zürich',
]
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
const token = () =>
  Math.floor(rand() * 36 ** 6).toString(36) + Math.floor(rand() * 36 ** 6).toString(36)

function work(doi: string, version = 0) {
  const authors = Array.from({ length: 2 + Math.floor(rand() * 18) }, () => ({
    given: words(1),
    family: words(1),
    sequence: 'additional',
    affiliation: [{ name: words(4) }],
  }))
  const refs = Array.from({ length: Math.floor(rand() * 50) }, (_, i) => ({
    key: `ref${i}`,
    DOI: `10.${1000 + Math.floor(rand() * 9000)}/${token()}`,
    'article-title': words(8),
    author: words(2),
    year: String(1950 + Math.floor(rand() * 75)),
    unstructured: words(20),
  }))
  return {
    id: doi,
    // The type follows the DOI, so an update lands on the same record.
    type: doi.charCodeAt(doi.length - 1) % 5 ? 'journal-article' : 'book-chapter',
    data: {
      DOI: doi,
      title: [words(10)],
      author: authors,
      reference: refs,
      abstract: rand() < 0.5 ? words(150) : undefined,
      published: { 'date-parts': [[2000 + Math.floor(rand() * 26), 1 + Math.floor(rand() * 12)]] },
      version,
    },
  }
}

// --- Ports -----------------------------------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), 'ul-memory-'))
const db = await openNodeDb(`file:${join(dir, 'db.sqlite')}`, {
  maxBoundParams: D1_MAX_BOUND_PARAMS,
})
const bucket = sampled(fileStore(join(dir, 'bucket')))
const signer = await ed25519Signer(await generateSigningKey())
const ports: Ports = {
  db,
  stores: createStores(db, noCache, {
    bucket,
    // File bytes aren't part of this; the store only has to presign.
    files: memoryStore() as never,
    repoPrefix: 'repo',
    internalPrefix: 'internal',
    memoryBytes: 8 * MB,
  }),
  cache: noCache,
  signer: async () => signer,
  jobs: new SqliteJobs(db),
  waitUntil: (p) => void p.catch((err) => console.error(err)),
  outboundFetch: (url, init) => fetch(url, init),
  locationFetch: (req) => fetch(req),
  locationKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
}
const app = createApp(() => ({
  ports,
  config: { appUrl: 'http://memory', deployment: 'test' },
  authenticate: async () => ({ userId: 'u1', scope: 'session', collectionIds: null }),
}))
await db.insert(schema.organization).values({ id: 'org1', name: 'Org', slug: 'org' })
await db.insert(schema.user).values({ id: 'u1', name: 'u1', email: 'u1@example.org' })
await db.insert(schema.member).values({ organizationId: 'org1', userId: 'u1', role: 'owner' })
const [collection] = await db
  .insert(schema.collections)
  .values({ organizationId: 'org1', slug: 'works', name: 'works', privateSalt: newSalt() })
  .returning()
await db.insert(schema.placements).values({
  collectionId: collection!.id,
  locationId: schema.PLATFORM_LOCATION_ID,
  role: 'primary',
  sets: 'public+private',
})
const path = '/api/collections/org/works'
const request = (p: string, init: { method?: string; body?: string; json?: unknown } = {}) =>
  app.fetch(
    new Request(`http://memory${p}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': init.json !== undefined ? 'application/json' : 'application/x-ndjson',
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
  )

/** Run queued jobs one at a time, interactive first (as claim orders them), measuring each. */
async function drain() {
  for (;;) {
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, 'queued'), lte(schema.jobs.runAt, new Date())))
      .orderBy(
        sql`CASE WHEN ${schema.jobs.type} IN (${sql.join(
          [...BULK_JOBS].map((t) => sql`${t}`),
          sql`, `,
        )}) THEN 1 ELSE 0 END`,
        asc(schema.jobs.runAt),
      )
      .limit(1)
    if (!job) return
    await db.delete(schema.jobs).where(eq(schema.jobs.id, job.id))
    await measure(job.type, () => runJob(job.payload as JobMessage, ports))
  }
}

/** One push: open, upload batches up to the server's limits, commit, run every job. */
async function push(records: Iterable<object>, schemas: Record<string, unknown> | undefined) {
  const open = await request(`${path}/push`, { method: 'POST', json: schemas ? { schemas } : {} })
  const sid = ((await open.json()) as { session_id: string }).session_id
  let lines: string[] = []
  let bytes = 0
  const send = async () => {
    const body = lines.join('\n')
    lines = []
    bytes = 0
    await measure('upload (request)', async () => {
      const r = await request(`${path}/push/${sid}/records`, { method: 'POST', body })
      if (r.status !== 200) throw new Error(`upload: ${r.status} ${await r.text()}`)
    })
    // Uploads queue compactions; run them as they come, as the queue would.
    await drain()
  }
  for (const rec of records) {
    const line = JSON.stringify(rec)
    const n = Buffer.byteLength(line) + 1
    if (lines.length >= MAX_BATCH_LINES || bytes + n > MAX_BATCH_BYTES - 64 * 1024) await send()
    lines.push(line)
    bytes += n
  }
  if (lines.length) await send()
  const t = Date.now()
  const c = await request(`${path}/push/${sid}/commit`, { method: 'POST', json: { async: true } })
  if (c.status !== 202) throw new Error(`commit: ${c.status} ${await c.text()}`)
  await drain()
  const s = (await (await request(`${path}/push/${sid}`)).json()) as {
    status: string
    error: unknown
    result: { semver: string; recordCount: number; changes: unknown }
  }
  if (s.status !== 'committed')
    throw new Error(`commit ended ${s.status}: ${JSON.stringify(s.error)}`)
  const { semver, recordCount, changes } = s.result
  console.error(`  ${semver}: ${recordCount} records, changes ${JSON.stringify(changes)}`)
  return Date.now() - t
}

const schemas = { 'journal-article': { type: 'object' }, 'book-chapter': { type: 'object' } }
const dois = Array.from(
  { length: RECORDS },
  () => `10.${1000 + Math.floor(rand() * 9000)}/${token()}`,
)
let rawBytes = 0
const first = function* () {
  for (const d of dois) {
    const w = work(d)
    rawBytes += Buffer.byteLength(JSON.stringify(w))
    yield w
  }
}
console.error(`push 1: ${RECORDS} records`)
const c1 = await push(first(), schemas)
console.error(
  `push 1 committed (${(rawBytes / MB).toFixed(0)} MB of records, commit ${(c1 / 1000).toFixed(0)} s)`,
)
const second = function* () {
  for (let i = 0; i < UPDATE; i++) yield work(dois[Math.floor(rand() * dois.length)]!, 1)
}
console.error(`push 2: ${UPDATE} updates spread over the first push's records`)
const c2 = await push(second(), undefined)
console.error(`push 2 committed (commit ${(c2 / 1000).toFixed(0)} s)`)

const rows = [...stats].sort((a, b) => b[1].peak - a[1].peak)
console.log(
  JSON.stringify(
    {
      records: RECORDS,
      recordMB: Math.round(rawBytes / MB),
      updates: UPDATE,
      budgets: {
        unitMB: parallelConfig.unitBytes / MB,
        pieceMB: compactConfig.pieceBytes / MB,
        commitRuns: compactConfig.commitRuns,
      },
      jobs: Object.fromEntries(
        rows.map(([k, v]) => [
          k,
          {
            n: v.n,
            peakMB: +(v.peak / MB).toFixed(1),
            heapMB: +(v.heap / MB).toFixed(1),
            buffersMB: +(v.buffers / MB).toFixed(1),
            seconds: Math.round(v.ms / 1000),
          },
        ]),
      ),
    },
    null,
    2,
  ),
)
await rm(dir, { recursive: true, force: true })
