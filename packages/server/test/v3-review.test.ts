/**
 * What the security review of v3 found and fixed (v3-deploy-plan.md, Phase 5 step 1): each
 * test fails on the code as it was. Runs on the v3 project only.
 */
import { createHash } from 'node:crypto'

import { memoryStore, v3 } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { runJob } from '../src/jobs.js'
import { pruneLayouts, v3JobConfig } from '../src/v3/jobs.js'
import { recoverUploads, uploadLimits } from '../src/v3/uploads.js'
import { cleanup, type Harness, harness } from './harness.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const json = async (r: Response) => (await r.json()) as Record<string, any>
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

async function setup() {
  const h = await harness({ newCollections: 'v3' })
  const user = await h.member()
  const c = await h.collection('lib', { recordLayout: 'v3' })
  return { h, user, c, base: '/api/collections/org/lib' }
}

type Built = { ref: v3.FileRef; bytes: Uint8Array }

/** Sorted-record-files as a client builds them, with their bytes. */
async function build(rows: v3.LineRow[]): Promise<Built[]> {
  const local = memoryStore()
  const session = v3.newSession()
  const files = await v3.buildFiles(rows.sort(v3.compareKey), v3.uploadTarget(local, session))
  return files.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ({
    ref,
    bytes: local.objects.get(v3.uploadKey(session, ref.id))!.bytes,
  }))
}

/** Open an upload and send its files by presigned URL. */
async function sendFiles(h: Harness, user: string, base: string, files: Built[]) {
  const opened = await json(await h.request(`${base}/uploads`, { method: 'POST', user, json: {} }))
  const id = opened.upload_id as string
  for (const f of files) {
    const res = await json(
      await h.request(`${base}/uploads/${id}/files`, {
        method: 'POST',
        user,
        json: { id: f.ref.id, size: f.bytes.byteLength },
      }),
    )
    await h.bucket.put(String(res.url).replace('memory://put/', ''), f.bytes)
  }
  return id
}

const commit = (h: Harness, user: string, base: string, id: string, body: object) =>
  h.request(`${base}/uploads/${id}/commit`, { method: 'POST', user, json: body })

/** Send files and commit them; the upload's status once its jobs have run. */
async function upload(h: Harness, user: string, base: string, files: Built[]) {
  const id = await sendFiles(h, user, base, files)
  await commit(h, user, base, id, { files: files.map((f) => f.ref) })
  await h.drain()
  const status = await json(await h.request(`${base}/uploads/${id}`, { user }))
  return { ...status, id } as Record<string, any>
}

const firstLoad = () =>
  build([
    v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
    v3.rowFromRecord('a1', 'Author', { name: 'Ada' }),
  ])

describe.skipIf(!onV3)('v3: what the security review fixed', () => {
  it('installs the bytes it checked, whatever the client sends after', async () => {
    const { h, user, base } = await setup()
    const [good] = await firstLoad()
    const [other] = await build([v3.rowFromRecord('Author', v3.SCHEMA_TYPE, { type: 'object' })])
    const id = await sendFiles(h, user, base, [good!])
    // The client's presigned URL still works after the commit is asked for: it sends other
    // bytes to the same key once the file has been verified, just before it is installed.
    const stored = `v3/${v3.recordKey(good!.ref.id)}`
    const sent = `v3/${v3.uploadKey(id, good!.ref.id)}`
    const head = h.bucket.head.bind(h.bucket)
    let swapped = false
    h.bucket.head = async (key) => {
      if (key === stored && !swapped) {
        swapped = true
        await h.bucket.put(sent, other!.bytes)
      }
      return head(key)
    }
    try {
      await commit(h, user, base, id, { files: [good!.ref] })
      await h.drain()
    } finally {
      h.bucket.head = head
    }
    expect(swapped).toBe(true)
    expect(await json(await h.request(`${base}/uploads/${id}`, { user }))).toMatchObject({
      status: 'committed',
    })
    expect(new Uint8Array(await (await h.bucket.get(stored))!.bytes())).toEqual(good!.bytes)
    await v3.verifyFile(h.ports.stores.v3, v3.recordKey(good!.ref.id), { id: good!.ref.id })
    expect((await h.request(`${base}/versions/latest/records/Author/a1`, { user })).status).toBe(
      200,
    )
  })

  it('takes an asset only from bytes uploaded to the collection, at their size', async () => {
    const { h, user, base } = await setup()
    await h.collection('other', { recordLayout: 'v3' })
    const other = '/api/collections/org/other'
    const bytes = 'private pdf bytes'
    const hash = sha(bytes)
    const asset = (size: number) => [
      v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
      v3.rowFromRecord(hash, v3.ASSET_TYPE, { size, mediaType: 'application/pdf' }),
    ]
    // One collection holds the asset.
    await h.request(`${base}/files/${hash}`, { method: 'PUT', user, body: bytes })
    expect(await upload(h, user, base, await build(asset(bytes.length)))).toMatchObject({
      status: 'committed',
    })
    expect(await h.ports.stores.v3.head(`assets/${hash}`)).not.toBe(null)
    // Another names its hash without sending the bytes: not taken, and not readable there.
    const files = await build(asset(bytes.length))
    let up = await upload(h, user, other, files)
    expect(up).toMatchObject({
      status: 'open',
      error: { error: 'Missing files', problems: [hash] },
    })
    expect((await h.request(`${other}/files/${hash}`, { user })).status).toBe(404)
    // Once it has sent them, the same commit lands.
    await h.request(`${other}/files/${hash}`, { method: 'PUT', user, body: bytes })
    await commit(h, user, other, up.id, { files: files.map((f) => f.ref) })
    await h.drain()
    expect(await json(await h.request(`${other}/uploads/${up.id}`, { user }))).toMatchObject({
      status: 'committed',
    })
    // A row that misstates the size, or is not an asset's data, is refused.
    up = await upload(h, user, base, await build(asset(bytes.length + 1)))
    expect(up).toMatchObject({ status: 'failed', error: { error: 'Assets refused' } })
    up = await upload(
      h,
      user,
      base,
      await build([v3.rowFromRecord(sha('x'), v3.ASSET_TYPE, { size: 'big' })]),
    )
    expect(up.status).toBe('failed')
    expect(JSON.stringify(up.error)).toMatch(/\$asset/)
    // And metadata is an object.
    up = await upload(h, user, base, await build([v3.rowFromRecord(v3.META_ID, v3.META_TYPE, 7)]))
    expect(up.status).toBe('failed')
    expect(JSON.stringify(up.error)).toMatch(/\$meta data must be an object/)
  })

  it('serves an asset whose type a browser would render as bytes, as v2 does', async () => {
    const { h, user, base } = await setup()
    const bytes = '<script>alert(1)</script>'
    const hash = sha(bytes)
    await h.request(`${base}/files/${hash}`, { method: 'PUT', user, body: bytes })
    const rows = [
      v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
      v3.rowFromRecord(hash, v3.ASSET_TYPE, { size: bytes.length, mediaType: 'text/html' }),
    ]
    expect(await upload(h, user, base, await build(rows))).toMatchObject({ status: 'committed' })
    const headRes = await h.request(`${base}/files/${hash}`, { method: 'HEAD', user })
    expect(headRes.headers.get('content-type')).toBe('application/octet-stream')
    const presigner = h.ports.stores.fileBytes.presigner
    const presignGet = presigner.presignGet
    const asked: (string | undefined)[] = []
    presigner.presignGet = async (key, opts) => {
      asked.push(opts?.contentType)
      return presignGet(key, opts)
    }
    try {
      expect((await h.request(`${base}/files/${hash}`, { user })).status).toBe(302)
    } finally {
      presigner.presignGet = presignGet
    }
    expect(asked).toEqual(['application/octet-stream'])
  })

  it('bounds what an upload may ask for', async () => {
    const { h, user, c, base } = await setup()
    const files = await firstLoad()
    const ref = files[0]!.ref
    const id = await sendFiles(h, user, base, files)
    const post = (path: string, body: object) =>
      h.request(`${base}/uploads/${id}${path}`, { method: 'POST', user, json: body })
    // A file past the largest taken: no presigned parts by the hundred thousand.
    expect((await post('/files', { id: ref.id, size: uploadLimits.maxFileBytes + 1 })).status).toBe(
      400,
    )
    // A completion's parts are numbers and ETags.
    for (const parts of [
      [],
      [{ n: '1</PartNumber>', etag: 'x' }],
      [{ n: 1 }],
      [{ n: 0, etag: 'x' }],
    ])
      expect((await post(`/files/${ref.id}/complete`, { upload_id: 'u', parts })).status).toBe(400)
    // A commit names each file once, with its keys, and nothing rides along.
    expect((await post('/commit', { files: [ref, ref] })).status).toBe(400)
    expect((await post('/commit', { files: [{ ...ref, first: undefined }] })).status).toBe(400)
    expect((await post('/commit', { files: [{ ...ref, first: 'ab', last: 'cd' }] })).status).toBe(
      400,
    )
    // A change with a key id nobody verified is refused; an unsigned one is taken.
    const change = { collection: c.id, files: [ref], base: null, message: 'by hand' }
    expect(
      (await post('/commit', { files: [ref], change: { ...change, keyId: 'k', sig: 's' } })).status,
    ).toBe(400)
    expect(
      (await post('/commit', { files: [{ ...ref, extra: 'x'.repeat(1000) }], change })).status,
    ).toBe(201)
    const [row] = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    expect(row!.message).toBe('by hand')
    const stored = await v3.readCommit(h.ports.stores.v3, c.id, 1)
    expect(Object.keys(stored!.commit.changes[0]!.files[0]!).sort()).toEqual(
      ['bytes', 'entries', 'first', 'id', 'last', 'records', 'removals'].sort(),
    )
    // Only an open upload is abandoned.
    expect((await h.request(`${base}/uploads/${id}`, { method: 'DELETE', user })).status).toBe(409)
  })

  it('fails a commit that never finishes, and counts uploads being committed', async () => {
    const { h, user, base } = await setup()
    const id = await sendFiles(h, user, base, await firstLoad())
    // As if its jobs kept dying: verifying, quiet, and a day past the commit's request.
    await h.ports.db
      .update(schema.v3Uploads)
      .set({ status: 'verifying', updatedAt: new Date(0), expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.v3Uploads.id, id))
    expect(await recoverUploads(h.ports)).toBe(1)
    expect(await h.drain()).toBe(0)
    expect(await json(await h.request(`${base}/uploads/${id}`, { user }))).toMatchObject({
      status: 'failed',
      error: { error: expect.stringMatching(/did not finish/) },
    })
    // Uploads in the middle of a commit count toward a user's limit, as open ones do.
    for (let i = 0; i < uploadLimits.open; i++) {
      const r = await h.request(`${base}/uploads`, { method: 'POST', user, json: {} })
      expect(r.status).toBe(201)
    }
    await h.ports.db
      .update(schema.v3Uploads)
      .set({ status: 'verifying' })
      .where(eq(schema.v3Uploads.status, 'open'))
    expect((await h.request(`${base}/uploads`, { method: 'POST', user, json: {} })).status).toBe(
      429,
    )
  })

  it('keeps a collection with no row and no tombstone until nothing of it is recent', async () => {
    const { h, user, c, base } = await setup()
    expect(await upload(h, user, base, await firstLoad())).toMatchObject({ status: 'committed' })
    // The database knows nothing of it: no row, and no tombstone (a database restored to an
    // earlier time, or the wrong one bound).
    await h.ports.db.delete(schema.collections).where(eq(schema.collections.id, c.id))
    await h.ports.db
      .delete(schema.collectionTombstones)
      .where(eq(schema.collectionTombstones.collectionId, c.id))
    await runJob({ type: 'v3.sweep' }, h.ports)
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(1)
    // Long after anything of it was written, it is dropped.
    for (const [key, o] of h.bucket.objects)
      if (key.startsWith(`v3/${v3.collectionPrefix(c.id)}`)) o.modified = 1
    await runJob({ type: 'v3.sweep' }, h.ports)
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(0)
  })

  it('runs one sweep pass at a time', async () => {
    const { h } = await setup()
    const ledgers = async () => (await h.ports.stores.v3.list('sweep/')).keys.length
    // A pass is running: this one does nothing.
    await h.ports.stores.internal.put('v3-sweep/running', String(Date.now()))
    await runJob({ type: 'v3.sweep' }, h.ports)
    expect(await ledgers()).toBe(0)
    // A lock a dead pass left is cleared, and the next pass runs.
    await h.ports.stores.internal.put('v3-sweep/running', '1')
    await runJob({ type: 'v3.sweep' }, h.ports)
    expect(await h.ports.stores.internal.head('v3-sweep/running')).toBe(null)
    await runJob({ type: 'v3.sweep' }, h.ports)
    expect(await ledgers()).toBe(1)
    expect(await h.ports.stores.internal.head('v3-sweep/running')).toBe(null)
  })

  /** Twelve small commits, a layout after each, so old layout files are pruned. */
  async function twelveCommits(h: Harness, user: string, base: string) {
    let semver: string | null = null
    for (let i = 0; i < 12; i++) {
      const opened = await h.request(`${base}/push`, {
        method: 'POST',
        user,
        json: semver ? { base: semver } : { schemas: { Author } },
      })
      const sid = (await json(opened)).session_id as string
      await h.request(`${base}/push/${sid}/records`, {
        method: 'POST',
        user,
        ndjson: [{ id: `a${i}`, type: 'Author', data: { name: `A${i}` } }],
      })
      const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
      expect(res.status).toBe(201)
      semver = (await json(res)).semver
      await h.drain()
    }
  }

  it('finds the newest layout once old ones are pruned, with the hint lost or stale', async () => {
    const { h, user, c, base } = await setup()
    const saved = { ...v3JobConfig }
    Object.assign(v3JobConfig, { adoptAfter: 1 })
    try {
      await twelveCommits(h, user, base)
      const store = h.ports.stores.v3
      const newest = (await v3.findLayout(store, c.id))!.number
      expect(newest).toBeGreaterThan(v3JobConfig.keepLayouts)
      expect(await v3.readLayout(store, c.id, 1)).toBe(null)
      // The hint's write is allowed to fail: lost, a reader probing from 1 finds no layout.
      // Pruning puts it back before it deletes anything more.
      await store.delete(v3.layoutHintKey(c.id))
      await pruneLayouts(store, c.id, v3JobConfig.keepLayouts)
      expect(await v3.readLayoutHint(store, c.id)).toBe(newest)
      expect((await v3.openView(store, c.id)).layout).toBe(newest)
      // A hint that names a layout since deleted: the layouts are listed.
      await v3.writeLayoutHint(store, c.id, 1)
      expect((await v3.openView(store, c.id)).layout).toBe(newest)
      expect((await v3.findLayout(store, c.id))!.number).toBe(newest)
    } finally {
      Object.assign(v3JobConfig, saved)
    }
  })

  it("passes fsck once a rebuild has replaced commits' files and the sweep has removed them", async () => {
    const { h, user, c, base } = await setup()
    await twelveCommits(h, user, base)
    const store = h.ports.stores.v3
    const { files } = await v3.currentFiles(store, c.id)
    const listed = new Set(files.map((f) => v3.recordKey(f.id)))
    const { keys } = await store.list('records/')
    const swept = keys.filter((k) => !listed.has(k))
    expect(swept.length).toBeGreaterThan(0)
    for (const k of swept) await store.delete(k)
    await runJob({ type: 'repo.fsck', collectionId: c.id, fileBytes: true }, h.ports)
    await h.drain()
    const report = JSON.parse(
      await (await h.ports.stores.internal.get(`fsck/${c.id}.json`))!.text(),
    )
    expect(report).toMatchObject({ ok: true, errors: [], versions: 12 })
    // A file the layout lists that is gone is still named.
    await store.delete(v3.recordKey(files[0]!.id))
    await runJob({ type: 'repo.fsck', collectionId: c.id }, h.ports)
    await h.drain()
    const after = JSON.parse(await (await h.ports.stores.internal.get(`fsck/${c.id}.json`))!.text())
    expect(after.ok).toBe(false)
    expect(JSON.stringify(after.errors)).toMatch(/is not stored/)
  })

  it('refuses a type name v3 keys cannot hold, when the push opens', async () => {
    const { h, user, base } = await setup()
    for (const type of ['#early', '__proto__']) {
      const res = await h.request(`${base}/push`, {
        method: 'POST',
        user,
        body: `{"schemas":{${JSON.stringify(type)}:${JSON.stringify(Author)}}}`,
        headers: { 'content-type': 'application/json' },
      })
      expect(res.status).toBe(422)
    }
  })

  it('names a download after a type whose name a header cannot hold', async () => {
    const { h, user, base } = await setup()
    const type = 'Au"thor é'
    const res = await h.request(`${base}/push`, {
      method: 'POST',
      user,
      json: { schemas: { [type]: Author } },
    })
    const sid = (await json(res)).session_id as string
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [{ id: 'a1', type, data: { name: 'Ada' } }],
    })
    expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      201,
    )
    const gz = await h.request(
      `${base}/versions/latest/records.ndjson.gz?type=${encodeURIComponent(type)}`,
      { user },
    )
    expect(gz.status).toBe(200)
    expect(gz.headers.get('content-disposition')).toBe(
      'attachment; filename="org-lib-v1.0.0-Au_thor__.ndjson.gz"',
    )
  })
})
