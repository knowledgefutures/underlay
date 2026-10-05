/**
 * Load test against a running deployment (v2-scale-review.md, "Load test"):
 * concurrent delta pushes, a stream of small commits, and
 * anonymous page and API reads, all at once. Reports latency percentiles,
 * status counts and commit times as JSON on stdout.
 *
 *   UL_KEYS=ul_a,ul_b npx tsx scripts/load.ts <baseUrl> <owner> [options]
 *
 *   --delta N         concurrent delta pushes (default 2)
 *   --records M       records per delta push (default 20000)
 *   --small N         small commits, one after another (default 10)
 *   --reads N         anonymous reads, eight at a time (default 100)
 *   --read-path P     what to read (default /explore; repeat for more)
 *   --cleanup         delete the collections it made afterwards
 *
 * Keys come from UL_KEYS (comma-separated), never the command line; pushes take
 * them in turn. Each user may hold 20 sessions at once, so a full run (20 delta
 * pushes and more) needs several users' keys. Every collection it makes is
 * private and named `load-<run>-…` under <owner>, which the keys must be able
 * to write to.
 */

const [baseArg, owner, ...rest] = process.argv.slice(2)
const keys = (process.env.UL_KEYS ?? '').split(',').filter(Boolean)
if (!baseArg || !owner || keys.length === 0) {
  console.error('usage: UL_KEYS=ul_… load.ts <baseUrl> <owner> [--delta N] [--records M] …')
  process.exit(2)
}
const base = baseArg.replace(/\/$/, '')
const opt = (name: string, def: number) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? Number(rest[i + 1]) : def
}
const readPaths = rest.flatMap((a, i) => (rest[i - 1] === '--read-path' ? [a] : []))
const cfg = {
  delta: opt('delta', 2),
  records: opt('records', 20_000),
  small: opt('small', 10),
  reads: opt('reads', 100),
  readPaths: readPaths.length ? readPaths : ['/explore'],
  cleanup: rest.includes('--cleanup'),
}
const run = Date.now().toString(36)
let turn = 0
const nextKey = () => keys[turn++ % keys.length]!

// --- measurement --------------------------------------------------------------------

const samples = new Map<string, number[]>()
const statuses = new Map<string, Map<number, number>>()
function note(kind: string, ms: number, status: number) {
  ;(samples.get(kind) ?? samples.set(kind, []).get(kind)!).push(ms)
  const m = statuses.get(kind) ?? statuses.set(kind, new Map()).get(kind)!
  m.set(status, (m.get(status) ?? 0) + 1)
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!) : null
}

async function call(
  kind: string,
  key: string | null,
  method: string,
  path: string,
  body?: unknown,
  ndjson?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const t = performance.now()
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        'content-type': ndjson !== undefined ? 'application/x-ndjson' : 'application/json',
      },
      ...(ndjson !== undefined
        ? { body: ndjson }
        : body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
    })
    const text = await res.text()
    // Budgets are per minute: wait them out, but count the 429.
    if (res.status === 429 && attempt < 5) {
      note(`${kind} (429 retried)`, 0, 429)
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? 10) * 1000))
      continue
    }
    note(kind, performance.now() - t, res.status)
    let json: Record<string, unknown> = {}
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      json = { text: text.slice(0, 200) }
    }
    return { status: res.status, json }
  }
}

// --- workloads ------------------------------------------------------------------------

const Item = {
  type: 'object',
  properties: { n: { type: 'integer' }, label: { type: 'string' }, tags: { type: 'array' } },
}
const record = (i: number, salt: string) => ({
  id: `i${String(i).padStart(9, '0')}`,
  type: 'Item',
  data: { n: i, label: `${salt}-${i}`, tags: [`t${i % 17}`, `u${i % 101}`] },
})
const made: { key: string; slug: string }[] = []

async function collection(key: string, slug: string) {
  const r = await call('collection create', key, 'POST', `/api/accounts/${owner}/collections`, {
    slug,
    name: slug,
    public: false,
  })
  if (r.status >= 300) throw new Error(`create ${slug}: ${r.status} ${JSON.stringify(r.json)}`)
  made.push({ key, slug })
  return `/api/collections/${owner}/${slug}`
}

/** Wait for an async commit; returns ms from commit request to committed. */
async function settle(kind: string, key: string, statusPath: string, t0: number) {
  for (;;) {
    const s = await call(`${kind} poll`, key, 'GET', statusPath)
    const st = s.json.status
    // A commit refused for missing files reopens the session, with the error.
    if (st === 'committed' || st === 'failed' || st === 'expired' || st === 'open') {
      note(`${kind} commit→${st}`, performance.now() - t0, 200)
      return st
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

async function deltaPush(i: number) {
  const key = nextKey()
  const col = await collection(key, `load-${run}-d${i}`)
  const open = await call('delta open', key, 'POST', `${col}/push`, { schemas: { Item } })
  const sid = open.json.session_id as string
  const BATCH = 10_000
  for (let at = 0; at < cfg.records; at += BATCH) {
    const lines = []
    for (let j = at; j < Math.min(cfg.records, at + BATCH); j++)
      lines.push(JSON.stringify(record(j, `d${i}`)))
    await call(
      'delta records batch',
      key,
      'POST',
      `${col}/push/${sid}/records`,
      undefined,
      lines.join('\n'),
    )
  }
  const t0 = performance.now()
  await call('delta commit', key, 'POST', `${col}/push/${sid}/commit?async=1`, {})
  await settle('delta', key, `${col}/push/${sid}`, t0)
}

async function smallCommits() {
  const key = nextKey()
  const col = await collection(key, `load-${run}-small`)
  for (let i = 0; i < cfg.small; i++) {
    const open = await call(
      'small open',
      key,
      'POST',
      `${col}/push`,
      i === 0 ? { schemas: { Item } } : {},
    )
    const sid = open.json.session_id as string
    const lines = Array.from({ length: 10 }, (_, j) => JSON.stringify(record(i * 10 + j, 's')))
    await call(
      'small records',
      key,
      'POST',
      `${col}/push/${sid}/records`,
      undefined,
      lines.join('\n'),
    )
    await call('small commit (sync)', key, 'POST', `${col}/push/${sid}/commit`, {})
  }
}

async function reads() {
  let next = 0
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < cfg.reads) {
        const path = cfg.readPaths[next++ % cfg.readPaths.length]!
        await call(`read ${path}`, null, 'GET', path)
      }
    }),
  )
}

// --- run ------------------------------------------------------------------------------

const started = performance.now()
const results = await Promise.allSettled([
  ...Array.from({ length: cfg.delta }, (_, i) => deltaPush(i)),
  smallCommits(),
  reads(),
])
const failures = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []))

if (cfg.cleanup) {
  for (const m of made) {
    await call('collection delete', m.key, 'DELETE', `/api/collections/${owner}/${m.slug}`)
  }
}

console.log(
  JSON.stringify(
    {
      run,
      config: cfg,
      seconds: Math.round((performance.now() - started) / 1000),
      failures,
      collections: made.map((m) => `${owner}/${m.slug}`),
      cleanedUp: cfg.cleanup,
      ms: Object.fromEntries(
        [...samples].map(([k, xs]) => [
          k,
          { n: xs.length, p50: pct(xs, 50), p99: pct(xs, 99), max: pct(xs, 100) },
        ]),
      ),
      statuses: Object.fromEntries([...statuses].map(([k, m]) => [k, Object.fromEntries(m)])),
    },
    null,
    2,
  ),
)

export {}
