/**
 * The checks on real R2 that the bench could only model (v3-deploy-plan.md, Phase 0):
 *
 *   race       two (and eight) creates of one new key at once: how many win, what losers get
 *   rate       new keys created under one prefix: how many a second, and any refusals
 *   multipart  a sorted-record-file sent as equal parts to presigned URLs, then verified
 *   reads      one record with 2, 7, and 20 files to check: requests and time
 *
 * Everything is written under one scratch prefix of the bucket and deleted at the end.
 * Credentials come from the environment, never from a file:
 *
 *   S3_ENDPOINT, S3_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 *   node --import tsx v3/r2-check.ts --prefix v3-scratch/<name> [--only race,rate,…] [--keep]
 */
import {
  type BlobObject,
  type ListPage,
  memoryStore,
  type PutOptions,
  s3Store,
  type Store,
  v3,
} from '../../packages/protocol/src/index.js'
import { record } from '../src/gen.js'
import { parseArgs, refOf, summary } from './lib.js'
import { rowOf, schemaRows } from './world.js'

const args = parseArgs(process.argv.slice(2))
const env = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} is not set`)
  return v
}
const prefix = String(args.prefix ?? '')
if (!/^v3-scratch\/[a-z0-9-]+$/.test(prefix)) {
  throw new Error('--prefix must be v3-scratch/<name>: the checks write nowhere else')
}
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null
const want = (name: string) => !only || only.has(name)

const endpoint = env('S3_ENDPOINT')
const bucket = env('S3_BUCKET')
const creds = { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') }
const s3 = s3Store({ endpoint, bucket, region: 'auto', ...creds })
const out = (what: string, value: unknown) =>
  console.log(JSON.stringify({ what, ...(value as object) }))

/** The S3 store under the scratch prefix, counting requests by kind. */
class Scratch implements Store {
  counts: Record<string, number> = {}
  constructor(readonly inner: typeof s3) {}
  #n(op: string) {
    this.counts[op] = (this.counts[op] ?? 0) + 1
  }
  get requests() {
    return Object.values(this.counts).reduce((a, b) => a + b, 0)
  }
  reset() {
    this.counts = {}
  }
  #k = (key: string) => `${prefix}/${key}`
  get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null> {
    this.#n('get')
    return this.inner.get(this.#k(key), range)
  }
  head(key: string) {
    this.#n('head')
    return this.inner.head(this.#k(key))
  }
  put(key: string, body: Uint8Array | string, opts?: PutOptions) {
    this.#n('put')
    return this.inner.put(this.#k(key), body, opts)
  }
  create(key: string, body: Uint8Array | string, opts?: PutOptions) {
    this.#n('create')
    return this.inner.create(this.#k(key), body, opts)
  }
  tail(key: string, length: number) {
    this.#n('tail')
    return this.inner.tail(this.#k(key), length)
  }
  async list(p: string, cursor?: string): Promise<ListPage> {
    this.#n('list')
    const page = await this.inner.list(this.#k(p), cursor)
    return { ...page, keys: page.keys.map((k) => k.slice(prefix.length + 1)) } as ListPage
  }
  delete(key: string) {
    this.#n('delete')
    return this.inner.delete(this.#k(key))
  }
  putParts(key: string, parts: AsyncIterable<Uint8Array>, opts?: PutOptions) {
    this.#n('putParts')
    return this.inner.putParts(this.#k(key), parts, opts)
  }
  copy(from: string, to: string, size?: number) {
    this.#n('copy')
    return this.inner.copy(this.#k(from), this.#k(to), size)
  }
}
const store = new Scratch(s3)

const tally = (xs: (number | string)[]) => {
  const t: Record<string, number> = {}
  for (const x of xs) t[String(x)] = (t[String(x)] ?? 0) + 1
  return t
}

/**
 * A raw create: the status R2 answers to a PUT with `If-None-Match: *`, unretried. The store
 * signs it and sends it through this fetch, which keeps the status; with no fetch given, the
 * store's client would retry a 429 itself.
 */
async function rawCreate(key: string, body: string): Promise<number> {
  let status = 0
  const spy = s3Store({
    endpoint,
    bucket,
    region: 'auto',
    ...creds,
    fetch: async (req) => {
      const res = await fetch(req)
      if (req.method === 'PUT' && status === 0) status = res.status
      return res
    },
  })
  try {
    await spy.create(`${prefix}/${key}`, body)
  } catch {
    // A refusal the store does not read as a loss; the status says which.
  }
  return status
}

async function race() {
  for (const writers of [2, 8]) {
    const trials = writers === 2 ? 40 : 15
    const winners: number[] = []
    const statuses: number[] = []
    const stored: string[] = []
    for (let t = 0; t < trials; t++) {
      const key = `race/${writers}/${t}-${crypto.randomUUID()}.json`
      const got = await Promise.all(
        Array.from({ length: writers }, (_, w) => rawCreate(key, JSON.stringify({ w }))),
      )
      winners.push(got.filter((s) => s === 200).length)
      statuses.push(...got)
      const obj = await s3.get(`${prefix}/${key}`)
      const w = obj ? (JSON.parse(await obj.text()) as { w: number }).w : -1
      // The stored body must be the one writer told 200.
      stored.push(w >= 0 && got[w] === 200 ? 'winner' : `other:${w}`)
    }
    out('race raw', {
      writers,
      trials,
      winners: tally(winners),
      statuses: tally(statuses),
      stored: tally(stored),
    })
    // The same through the store's create, which reads a 429 with the key present as a loss.
    const wins: number[] = []
    const errors: string[] = []
    for (let t = 0; t < trials; t++) {
      const key = `race-store/${writers}/${t}-${crypto.randomUUID()}.json`
      const got = await Promise.allSettled(
        Array.from({ length: writers }, (_, w) => store.create(key, JSON.stringify({ w }))),
      )
      wins.push(got.filter((g) => g.status === 'fulfilled' && g.value).length)
      for (const g of got) if (g.status === 'rejected') errors.push(String(g.reason).slice(0, 120))
    }
    out('race store.create', { writers, trials, winners: tally(wins), errors: tally(errors) })
  }
}

async function rate() {
  for (const concurrency of [1, 8, 32]) {
    const n = concurrency === 1 ? 60 : 300
    const statuses: number[] = []
    const ms: number[] = []
    let next = 0
    const t0 = performance.now()
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < n) {
          const i = next++
          const s = performance.now()
          statuses.push(
            await rawCreate(`rate/c${concurrency}/${String(i).padStart(6, '0')}.json`, '{}'),
          )
          ms.push(performance.now() - s)
        }
      }),
    )
    const secs = (performance.now() - t0) / 1000
    out('rate', {
      concurrency,
      keys: n,
      perSecond: Math.round((n / secs) * 10) / 10,
      statuses: tally(statuses),
      ms: summary(ms.sort((a, b) => a - b)),
    })
  }
}

/** Rows that compress poorly, so a modest file spans several 8 MiB parts. */
function* blobRows(n: number): Generator<v3.LineRow> {
  const bytes = new Uint8Array(300)
  for (let i = 0; i < n; i++) {
    crypto.getRandomValues(bytes)
    yield v3.rowFromRecord(`b${String(i).padStart(8, '0')}`, 'blob', {
      noise: Buffer.from(bytes).toString('base64'),
    })
  }
}

async function multipart() {
  const mem = memoryStore()
  const session = v3.newSession()
  const files = await v3.buildFiles(blobRows(80_000), v3.uploadTarget(mem, session), {
    maxEntries: 1_000_000,
    cutBytes: 1024 ** 3,
  })
  if (files.length !== 1) throw new Error(`expected one file, built ${files.length}`)
  const file = files[0]!
  const bytes = await (await mem.get(v3.uploadKey(session, file.id)))!.bytes()
  const key = v3.uploadKey(session, file.id)
  const full = `${prefix}/${key}`
  const t0 = performance.now()
  const uploadId = await s3.presigner.createMultipart(full)
  const parts: { partNumber: number; etag: string }[] = []
  const sizes: number[] = []
  let n = 0
  for await (const part of v3.equalParts(
    (async function* () {
      yield bytes
    })(),
  )) {
    n++
    const signed = await s3.presigner.presignPart(full, uploadId, n, 900)
    // The client's half: a plain PUT to the URL, no credentials.
    const res = await fetch(signed, { method: 'PUT', body: part as BodyInit })
    if (!res.ok) throw new Error(`part ${n}: ${res.status} ${await res.text()}`)
    parts.push({ partNumber: n, etag: res.headers.get('etag') ?? '' })
    sizes.push(part.byteLength)
  }
  await s3.presigner.completeMultipart(full, uploadId, parts)
  const uploadMs = performance.now() - t0
  const t1 = performance.now()
  const checked = await v3.verifyFile(store, key)
  out('multipart', {
    bytes: bytes.byteLength,
    parts: sizes.length,
    partSizes: tally(sizes),
    uploadMs: Math.round(uploadMs),
    verified: checked.id === file.id,
    verifyMs: Math.round(performance.now() - t1),
    head: await s3.head(full),
  })
  // And one small file by a single presigned PUT.
  const small = memoryStore()
  const s2 = v3.newSession()
  const [f2] = await v3.buildFiles(blobRows(200), v3.uploadTarget(small, s2))
  const b2 = await (await small.get(v3.uploadKey(s2, f2!.id)))!.bytes()
  const putUrl = await s3.presigner.presignPut(`${prefix}/${v3.uploadKey(s2, f2!.id)}`, {
    expiresIn: 900,
  })
  const res = await fetch(putUrl, { method: 'PUT', body: b2 as BodyInit })
  const c2 = await v3.verifyFile(store, v3.uploadKey(s2, f2!.id))
  out('presigned put', { status: res.status, bytes: b2.byteLength, verified: c2.id === f2!.id })
}

const SEED = 7
const LOAD = 100_000
const CHANGES = 2_000

async function commitRows(collection: string, rows: Iterable<v3.LineRow>, message: string) {
  const session = v3.newSession()
  const sorted = [...rows].sort(v3.compareKey)
  const files = await v3.buildFiles(sorted, v3.uploadTarget(store, session))
  const change = await v3.makeChange(collection, { files: files.map(refOf), message })
  store.reset()
  const t0 = performance.now()
  const made = await v3.commitUpload(store, collection, { change }, { session })
  return {
    number: made.commit.number,
    ms: Math.round(performance.now() - t0),
    requests: store.requests,
  }
}

function* changeRows(day: number): Generator<v3.LineRow> {
  // Spread over the keys, as a day's changes are; each index once per day.
  const seen = new Set<number>()
  let x = day * 7919 + 1
  while (seen.size < CHANGES) {
    x = (x * 48271) % 2147483647
    const i = x % LOAD
    if (seen.has(i)) continue
    seen.add(i)
    yield rowOf(record(SEED, i, day + 1))
  }
}

async function reads() {
  const collection = `r2check-${crypto.randomUUID().slice(0, 8)}`
  await v3.createCollection(store, collection)
  const load = function* () {
    yield* schemaRows()
    for (let i = 0; i < LOAD; i++) yield rowOf(record(SEED, i, 0))
  }
  out('load', await commitRows(collection, load(), 'first load'))
  let day = 0
  for (const target of [2, 7, 20]) {
    while (day + 1 < target)
      out('commit', await commitRows(collection, changeRows(++day), `day ${day}`))
    const files = (await v3.openView(store, collection)).files.length
    // Cold: a new cache, so the view and every footer are read.
    const keys = Array.from({ length: 21 }, (_, k) => record(SEED, (k * 4999 + 13) % LOAD, 0))
    store.reset()
    const t0 = performance.now()
    const cache = new v3.FileCache()
    const view = await v3.openView(store, collection)
    const viewReq = store.requests
    const first = await v3.getRecord(store, view, keys[0]!.type, keys[0]!.id, { cache })
    const cold = {
      ms: Math.round(performance.now() - t0),
      requests: store.requests,
      viewRequests: viewReq,
    }
    if (!first) throw new Error('cold read found nothing')
    // Footers cached: the rest of the keys, one at a time.
    const ms: number[] = []
    const req: number[] = []
    for (const k of keys.slice(1)) {
      store.reset()
      const s = performance.now()
      const got = await v3.getRecord(store, view, k.type, k.id, { cache })
      if (!got) throw new Error(`no record for ${k.type}/${k.id}`)
      ms.push(performance.now() - s)
      req.push(store.requests)
    }
    out('reads', {
      files,
      cold,
      warm: { requests: summary(req.sort((a, b) => a - b)), ms: summary(ms.sort((a, b) => a - b)) },
    })
  }
}

async function clean() {
  let deleted = 0
  let cursor: string | undefined
  const keys: string[] = []
  do {
    const page = await s3.list(`${prefix}/`, cursor)
    keys.push(...page.keys.map((k) => (typeof k === 'string' ? k : (k as { key: string }).key)))
    cursor = page.cursor ?? undefined
  } while (cursor)
  await v3.inParallel(
    keys.map((k) => async () => {
      await s3.delete(k)
      deleted++
    }),
    16,
  )
  out('clean', { deleted })
}

async function main() {
  out('start', { bucket, prefix, at: new Date().toISOString() })
  try {
    if (want('race')) await race()
    if (want('rate')) await rate()
    if (want('multipart')) await multipart()
    if (want('reads')) await reads()
  } finally {
    if (!args.keep) await clean()
  }
}

await main()
