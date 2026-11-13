/**
 * Time a large session push into an empty v3 collection, step by step (push/trace.ts):
 * uploads in batches, compaction as it goes, then the commit job. Prints each commit
 * step's wall time, the commit job's CPU time, and peak memory (JS heap plus array
 * buffers, sampled after a GC every 2 s), so a commit of N records can be sized against
 * the bulk Worker's limits (300 s of CPU, 128 MB).
 *
 *   node --expose-gc --import tsx scripts/v3-session-commit.ts <records.jsonl> <schemas.json> [batch]
 *
 * records.jsonl: one `{id, type, data}` a line (system/public-graph's ingest writes these);
 * schemas.json: `{ "schemas": { Type: schema } }` or the schemas themselves.
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import { eq } from 'drizzle-orm'

import * as schema from '../src/db/schema.js'
import { drainSqliteJobs } from '../src/jobs.js'
import { traceConfig } from '../src/push/trace.js'
import { sessionBuildConfig } from '../src/v3/session-build.js'
import { harness } from '../test/harness.js'

const [file, schemaFile, batchArg] = process.argv.slice(2)
if (!file || !schemaFile) {
  console.error('usage: v3-session-commit.ts <records.jsonl> <schemas.json> [batch]')
  process.exit(2)
}
const batch = Number(batchArg ?? 5000)
// PART_MB=N: build in parts of about N MB of run lines (v3/session-build.ts).
if (process.env.PART_MB) sessionBuildConfig.partBytes = Number(process.env.PART_MB) * 1024 * 1024
const raw = JSON.parse(await readFile(schemaFile, 'utf8'))
const schemas = raw.schemas ?? raw

const gc = (globalThis as { gc?: () => void }).gc
const used = () => {
  const m = process.memoryUsage()
  return m.heapUsed + m.arrayBuffers
}
let peak = 0
let base = 0
const sampler = setInterval(() => {
  gc?.()
  peak = Math.max(peak, used() - base)
}, 2000)

const h = await harness({ newCollections: 'v3' })
const user = await h.member()
await h.collection('graph', { recordLayout: 'v3' })
const path = '/api/collections/org/graph'
const opened = await h.request(`${path}/push`, { method: 'POST', user, json: { schemas } })
if (opened.status !== 200) throw new Error(`open: ${opened.status} ${await opened.text()}`)
const sid = ((await opened.json()) as { session_id: string }).session_id

// Upload, compacting as the server would between batches.
const t0 = Date.now()
let lines: string[] = []
let n = 0
const send = async () => {
  const r = await h.request(`${path}/push/${sid}/records`, {
    method: 'POST',
    user,
    body: lines.join('\n'),
    headers: { 'content-type': 'application/x-ndjson' },
  })
  if (r.status !== 200) throw new Error(`records: ${r.status} ${await r.text()}`)
  n += lines.length
  lines = []
  await drainSqliteJobs(h.ports)
}
for await (const line of createInterface({ input: createReadStream(file) })) {
  if (!line) continue
  lines.push(line)
  if (lines.length >= batch) await send()
}
if (lines.length > 0) await send()
const runs = await h.ports.db
  .select()
  .from(schema.pushRuns)
  .where(eq(schema.pushRuns.sessionId, sid))
console.log(`uploaded ${n} records in ${Date.now() - t0} ms; ${runs.length} runs`)

// The commit, as a job, traced.
traceConfig.progressMs = 10_000
const events: Record<string, unknown>[] = []
const log = console.log
console.log = (...args: unknown[]) => {
  const [e] = args as [Record<string, unknown>]
  if (e && typeof e === 'object' && e.event === 'push.commit') {
    events.push(e)
    if (e.at !== 'start') log(JSON.stringify(e))
    return
  }
  log(...args)
}
gc?.()
base = used()
peak = 0
const cpu0 = process.cpuUsage()
const t1 = Date.now()
const res = await h.request(`${path}/push/${sid}/commit`, {
  method: 'POST',
  user,
  json: { async: true },
})
await drainSqliteJobs(h.ports)
const cpu = process.cpuUsage(cpu0)
clearInterval(sampler)
console.log = log
const status = (await (await h.request(`${path}/push/${sid}`, { user })).json()) as Record<
  string,
  unknown
>
console.log(
  JSON.stringify({
    commit: res.status,
    status: status.status,
    error: status.error,
    wall_ms: Date.now() - t1,
    cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
    peak_mb: Math.round(peak / 1e6),
    records: n,
  }),
)
process.exit(0)
