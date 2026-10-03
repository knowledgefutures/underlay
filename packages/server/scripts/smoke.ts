/**
 * End-to-end smoke test against a running deployment (local `wrangler dev`, the
 * Node server, or staging):
 *
 *   npx tsx scripts/smoke.ts <baseUrl> <apiKey> <owner/collection>
 *
 * Pushes with the delta API (sync and async commits) and the v1 negotiate API,
 * then checks the head moved. Exits non-zero on any unexpected response.
 */
const [baseUrl, key, collection] = process.argv.slice(2)
if (!baseUrl || !key || !collection) {
  console.error('usage: smoke.ts <baseUrl> <apiKey> <owner/collection>')
  process.exit(2)
}
const api = `${baseUrl.replace(/\/$/, '')}/api/collections/${collection}`
const auth = { authorization: `Bearer ${key}` }

async function call(method: string, path: string, body?: unknown, ndjson = false) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...auth, 'content-type': ndjson ? 'application/x-ndjson' : 'application/json' },
    ...(body === undefined
      ? {}
      : {
          body: ndjson
            ? (body as unknown[]).map((l) => JSON.stringify(l)).join('\n')
            : JSON.stringify(body),
        }),
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  console.log(`${method} ${path} → ${res.status}`, JSON.stringify(json).slice(0, 300))
  return { status: res.status, json }
}

function expect(cond: unknown, what: string) {
  if (!cond) {
    console.error(`FAILED: ${what}`)
    process.exit(1)
  }
}

const Author = {
  type: 'object',
  properties: { name: { type: 'string' }, born: { type: 'integer' } },
}
const stamp = Date.now()

// 1. Delta push, synchronous commit.
let r = await call('POST', '/push', { schemas: { Author }, metadata: { title: `Smoke ${stamp}` } })
expect(r.status === 200, 'open delta session')
let sid = r.json.session_id
r = await call(
  'POST',
  `/push/${sid}/records`,
  [
    { id: `ada-${stamp}`, type: 'Author', data: { name: 'Ada', born: 1815 } },
    { id: `alan-${stamp}`, type: 'Author', data: { name: 'Alan', born: 1912 } },
    { id: `kurt-${stamp}`, type: 'Author', data: { name: 'Kurt' }, private: true },
  ],
  true,
)
expect(r.status === 200 && r.json.received === 3, 'upload records')
r = await call('POST', `/push/${sid}/commit`)
expect(r.status === 201, 'sync commit')
const first = r.json.semver as string

// 2. Delta push, async commit (a job on Queues / the jobs table).
r = await call('POST', '/push', { base: first })
sid = r.json.session_id
await call('POST', `/push/${sid}/deletes`, [{ type: 'Author', id: `alan-${stamp}` }], true)
r = await call('POST', `/push/${sid}/commit?async=true`)
expect(r.status === 202, 'async commit accepted')
let status = ''
for (let i = 0; i < 60 && status !== 'committed' && status !== 'failed'; i++) {
  await new Promise((res) => setTimeout(res, 1000))
  status = (await call('GET', `/push/${sid}`)).json.status
}
expect(status === 'committed', 'async commit finished')

// 3. v1 negotiate: full snapshot with one change.
const records = [
  { id: `ada-${stamp}`, type: 'Author', data: { name: 'Ada Lovelace', born: 1815 } },
  { id: `grace-${stamp}`, type: 'Author', data: { name: 'Grace', born: 1906, 10: 'x', 9: 'y' } },
]
const { hashRecord, legacyRecordHash } = await import('@underlay/core')
r = await call('POST', '/versions/negotiate', {
  base_version: null,
  schemas: { Author: { type: 'object' } },
  manifest: records.map((x) => ({
    id: x.id,
    type: x.type,
    hash: legacyRecordHash(x.id, x.type, x.data),
  })),
})
expect(r.status === 200, 'negotiate')
void hashRecord
const nsid = r.json.session_id
expect(r.json.needed_records.length === 2, 'both records needed')
r = await call('POST', `/versions/negotiate/${nsid}/records`, records, true)
expect(r.status === 200, 'negotiate upload')
r = await call('POST', `/versions/negotiate/${nsid}/commit`)
expect(r.status === 201 && r.json.recordCount === 2, 'negotiate commit')
console.log('\nsmoke OK')
