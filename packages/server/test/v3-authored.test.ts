/**
 * Phase 0 of the Underlay CLI (local-tool-build.md): commits built by their author and
 * stored unchanged, receipts beside every commit, a collection's authority, a client-chosen
 * collection id, and the routes that follow a collection's log and fetch its files.
 */
import { memoryStore, v3 } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { commitPage } from '../src/api/commits.js'
import * as schema from '../src/db/schema.js'
import { runJob } from '../src/jobs.js'
import { forgetDenylist } from '../src/lib/limits.js'
import { recoverUploads } from '../src/v3/uploads.js'
import { cleanup, type Harness, harness } from './harness.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const json = async (r: Response) => (await r.json()) as Record<string, any>
const dec = new TextDecoder()

type Built = { ref: v3.FileRef; bytes: Uint8Array }

async function build(rows: v3.LineRow[]): Promise<Built[]> {
  const local = memoryStore()
  const session = v3.newSession()
  const files = await v3.buildFiles(rows.sort(v3.compareKey), v3.uploadTarget(local, session))
  return files.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ({
    ref,
    bytes: local.objects.get(v3.uploadKey(session, ref.id))!.bytes,
  }))
}

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

/** Build a commit here on `previous`, send its files, and commit it; the upload's status. */
async function push(
  h: Harness,
  user: string,
  base: string,
  cid: string,
  previous: v3.StoredCommit | null,
  rows: v3.LineRow[],
  bump: 'major' | 'minor' | 'patch',
  /** What to change of the commit before it is sent: its change's base, its time. */
  alter: { base?: string | null; createdAt?: string } = {},
) {
  const files = await build(rows)
  const change = await v3.makeChange(cid, {
    files: files.map((f) => f.ref),
    base: alter.base === undefined ? (previous?.id ?? null) : alter.base,
    message: 'from here',
  })
  let built = await v3.buildCommit({ collection: cid, previous, change, bump })
  if (alter.createdAt !== undefined) {
    const bytes = v3.commitBytes({ ...built.commit, createdAt: alter.createdAt })
    built = { commit: v3.parseCommit(bytes), id: v3.versionId(bytes), bytes }
  }
  const id = await sendFiles(h, user, base, files)
  const res = await h.request(`${base}/uploads/${id}/commit`, {
    method: 'POST',
    user,
    json: { files: files.map((f) => f.ref), commit: dec.decode(built.bytes) },
  })
  await h.drain()
  const status = await json(await h.request(`${base}/uploads/${id}`, { user }))
  return { built, res, status, id }
}

async function setup() {
  const h = await harness({ newCollections: 'v3' })
  const user = await h.member()
  const c = await h.collection('lib', { recordLayout: 'v3' })
  return { h, user, c, base: '/api/collections/org/lib' }
}

describe.skipIf(!onV3)('v3: commits built by their author', () => {
  it('stores the commit unchanged, with a receipt, and the log serves both', async () => {
    const { h, user, c, base } = await setup()
    const first = await push(
      h,
      user,
      base,
      c.id,
      null,
      [
        v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
        v3.rowFromRecord('a1', 'Author', { name: 'Ada' }),
      ],
      'major',
    )
    expect(first.status).toMatchObject({ status: 'committed' })
    expect(first.status.result.hash).toBe(first.built.id)
    const stored = await v3.readCommit(h.ports.stores.v3, c.id, 1)
    expect(stored!.id).toBe(first.built.id)
    const receipt = await v3.readReceipt(h.ports.stores.v3, c.id, 1)
    expect(receipt).toMatchObject({
      number: 1,
      version: v3.versionHex(first.built.id),
      server: 'test',
    })
    expect(await v3.verifyReceipt(receipt!, stored!, [h.signer.publicKey])).toBe(true)

    const second = await push(
      h,
      user,
      base,
      c.id,
      first.built,
      [v3.rowFromRecord('a2', 'Author', { name: 'Grace' })],
      'minor',
    )
    expect(second.status).toMatchObject({ status: 'committed', result: { semver: 'v1.1.0' } })
    // Verifies with the server's key through receipts, though it signed no commit.
    expect(
      (
        await v3.verifyLog(h.ports.stores.v3, c.id, {
          serverKeys: [h.signer.publicKey],
          receipts: true,
          files: true,
        })
      )?.id,
    ).toBe(second.built.id)

    const log = await json(await h.request(`${base}/commits?after=0`, { user }))
    expect(log).toMatchObject({ head: 2, more: false, collection: { id: c.id, authority: 'test' } })
    expect(log.commits.map((x: any) => x.id)).toEqual([first.built.id, second.built.id])
    expect(v3.versionId(new TextEncoder().encode(log.commits[1].commit))).toBe(second.built.id)
    expect(log.commits[1].receipt.version).toBe(v3.versionHex(second.built.id))
    expect(await json(await h.request(`${base}/log?after=1`, { user }))).toMatchObject({
      head: 2,
      commits: [{ number: 2 }],
    })
    expect(await json(await h.request(`${base}/commits/2`, { user }))).toMatchObject({
      number: 2,
      id: second.built.id,
    })
    expect((await h.request(`${base}/commits/3`, { user })).status).toBe(404)
  })

  it('refuses a commit built on a version that is not the newest, naming the newest', async () => {
    const { h, user, c, base } = await setup()
    const rows = [
      v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
      v3.rowFromRecord('a1', 'Author', { name: 'Ada' }),
    ]
    const first = await push(h, user, base, c.id, null, rows, 'major')
    // Built on nothing, though commit 1 is there now.
    const late = await push(
      h,
      user,
      base,
      c.id,
      null,
      [...rows, v3.rowFromRecord('a9', 'Author', { name: 'Late' })],
      'major',
    )
    expect(late.status).toMatchObject({
      status: 'failed',
      error: { statusCode: 409, latest: { number: 1, id: first.built.id, semver: 'v1.0.0' } },
    })
    // Replayed on the newest, it lands with its new number.
    const ch = late.built.commit.changes[0]!
    const { commits } = await v3.replayCommits([late.built], first.built, () => 'minor')
    expect(commits[0]!.commit).toMatchObject({
      number: 2,
      previous: v3.versionHex(first.built.id),
    })
    const files = await build([...rows, v3.rowFromRecord('a9', 'Author', { name: 'Late' })])
    expect(files.map((f) => f.ref)).toEqual(ch.files)
    const id = await sendFiles(h, user, base, files)
    await h.request(`${base}/uploads/${id}/commit`, {
      method: 'POST',
      user,
      json: { files: ch.files, commit: dec.decode(commits[0]!.bytes) },
    })
    await h.drain()
    expect(await json(await h.request(`${base}/uploads/${id}`, { user }))).toMatchObject({
      status: 'committed',
      result: { hash: commits[0]!.id, semver: 'v1.1.0' },
    })
  })

  it('refuses a commit whose semver or files are not what its rows call for', async () => {
    const { h, user, c, base } = await setup()
    const rows = [
      v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
      v3.rowFromRecord('a1', 'Author', { name: 'Ada' }),
    ]
    const first = await push(h, user, base, c.id, null, rows, 'major')
    // A record row is minor, not patch.
    const wrong = await push(
      h,
      user,
      base,
      c.id,
      first.built,
      [v3.rowFromRecord('a2', 'Author', { name: 'G' })],
      'patch',
    )
    expect(wrong.status).toMatchObject({ status: 'failed', error: { statusCode: 422 } })
    expect(JSON.stringify(wrong.status.error)).toContain('semver')
    // Another collection's commit, or files other than the upload's, never get as far.
    const files = await build([v3.rowFromRecord('a3', 'Author', { name: 'H' })])
    const other = await v3.buildCommit({
      collection: 'someone-else',
      previous: first.built,
      change: await v3.makeChange('someone-else', { files: files.map((f) => f.ref) }),
      bump: 'minor',
    })
    const id = await sendFiles(h, user, base, files)
    const res = await h.request(`${base}/uploads/${id}/commit`, {
      method: 'POST',
      user,
      json: { files: files.map((f) => f.ref), commit: dec.decode(other.bytes) },
    })
    expect(res.status).toBe(400)
    // A commit dated an hour ago (the library would not build one before the commit it follows).
    const fresh = await v3.buildCommit({
      collection: c.id,
      previous: first.built,
      change: await v3.makeChange(c.id, { files: files.map((f) => f.ref) }),
      bump: 'minor',
    })
    const old = v3.commitBytes({
      ...fresh.commit,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    })
    const res2 = await h.request(`${base}/uploads/${id}/commit`, {
      method: 'POST',
      user,
      json: { files: files.map((f) => f.ref), commit: dec.decode(old) },
    })
    expect(res2.status).toBe(400)
    expect((await json(res2)).error).toContain('createdAt')
  })

  it('takes versions only where it is the authority', async () => {
    const { h, user, c, base } = await setup()
    await v3.createCollection(h.ports.stores.v3, c.id, { authority: 'elsewhere.org' })
    const r = await push(
      h,
      user,
      base,
      c.id,
      null,
      [v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author)],
      'major',
    )
    expect(r.res.status).toBe(409)
    expect((await json(r.res)).error).toContain('elsewhere.org')
  })

  it('writes a receipt for a commit it builds itself', async () => {
    const { h, user, c, base } = await setup()
    const files = await build([v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author)])
    const id = await sendFiles(h, user, base, files)
    await h.request(`${base}/uploads/${id}/commit`, {
      method: 'POST',
      user,
      json: { files: files.map((f) => f.ref) },
    })
    await h.drain()
    expect(await v3.readReceipt(h.ports.stores.v3, c.id, 1)).toMatchObject({ number: 1 })
  })
})

describe.skipIf(!onV3)('v3: following a collection and fetching its files', () => {
  it('serves the files the current version names, whole or by range, and nothing else', async () => {
    const { h, user, c, base } = await setup()
    const rows = [
      v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
      v3.rowFromRecord('a1', 'Author', { name: 'Ada' }),
    ]
    const first = await push(h, user, base, c.id, null, rows, 'major')
    expect(await json(await h.request(`${base}/layout`, { user }))).toEqual({ layout: null })
    const f = first.built.commit.changes[0]!.files[0]!
    const whole = await h.request(`${base}/record-files/${f.id}`, { user })
    expect(whole.status).toBe(200)
    const bytes = new Uint8Array(await whole.arrayBuffer())
    // The bytes are the file: its id checks out.
    const local = memoryStore()
    await local.put(v3.recordKey(f.id), bytes)
    expect((await v3.verifyFile(local, v3.recordKey(f.id), { id: f.id })).content.entries).toBe(2)
    const part = await h.request(`${base}/record-files/${f.id}`, {
      user,
      headers: { range: 'bytes=0-9' },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-9/${bytes.byteLength}`)
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(0, 10))
    // A file this collection does not name is not served, whoever stores it.
    const other = await build([v3.rowFromRecord('x', 'Author', { name: 'X' })])
    await h.ports.stores.v3.put(v3.recordKey(other[0]!.ref.id), other[0]!.bytes)
    expect((await h.request(`${base}/record-files/${other[0]!.ref.id}`, { user })).status).toBe(404)
    // A private collection's files need read access.
    expect((await h.request(`${base}/record-files/${f.id}`)).status).toBe(404)
  })
})

describe.skipIf(!onV3)('v3: a collection created with the id its commits carry', () => {
  it('takes a new UUID once, and refuses one in use', async () => {
    const { h, user } = await setup()
    const id = crypto.randomUUID()
    const make = (slug: string, cid: string) =>
      h.request('/api/accounts/org/collections', {
        method: 'POST',
        user,
        json: { slug, id: cid },
      })
    const res = await make('chosen', id)
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ id, slug: 'chosen' })
    expect((await make('again', id)).status).toBe(409)
    expect((await make('bad', 'not-a-uuid')).status).toBe(422)
  })
})

/** The findings of the phase 0 review (planning: local-tool-phase0-review.md), each held. */
describe.skipIf(!onV3)('v3: what the phase 0 review found', () => {
  const firstRows = () => [
    v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
    v3.rowFromRecord('a1', 'Author', { name: 'Ada' }),
  ]
  const one = (id: string) => [v3.rowFromRecord(id, 'Author', { name: id })]
  const makePublic = (h: Harness, id: string) =>
    h.ports.db.update(schema.collections).set({ public: true }).where(eq(schema.collections.id, id))
  /** What recovery does once a commit has been quiet for a quarter of an hour. */
  async function recover(h: Harness, upload: string) {
    await h.ports.db
      .update(schema.v3Uploads)
      .set({ updatedAt: new Date(Date.now() - 3600_000) })
      .where(eq(schema.v3Uploads.id, upload))
    await recoverUploads(h.ports)
    await h.drain()
  }

  it('refuses a commit whose base is no version of the collection, as for a commit built here', async () => {
    const { h, user, c, base } = await setup()
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    const stray = await push(h, user, base, c.id, first.built, one('a2'), 'minor', {
      base: `ulv3:${'ab'.repeat(32)}`,
    })
    expect(stray.status).toMatchObject({ status: 'failed', error: { statusCode: 422 } })
    expect(JSON.stringify(stray.status.error)).toContain('is not a version of')
    // Nothing was stored, and the log still checks out.
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(1)
    expect((await v3.verifyLog(h.ports.stores.v3, c.id))?.id).toBe(first.built.id)
    // A base that is an earlier version is taken, the commit before or not.
    const second = await push(h, user, base, c.id, first.built, one('a2'), 'minor')
    const third = await push(h, user, base, c.id, second.built, one('a3'), 'minor', {
      base: first.built.id,
    })
    expect(third.status).toMatchObject({ status: 'committed' })
    expect((await v3.verifyLog(h.ports.stores.v3, c.id))?.id).toBe(third.built.id)
  })

  it('refuses a commit dated before the one it follows', async () => {
    const { h, user, c, base } = await setup()
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    const early = await push(h, user, base, c.id, first.built, one('a2'), 'minor', {
      createdAt: new Date(Date.parse(first.built.commit.createdAt) - 1000).toISOString(),
    })
    expect(early.status).toMatchObject({ status: 'failed', error: { statusCode: 422 } })
    expect(JSON.stringify(early.status.error)).toContain('before the version it follows')
  })

  it('finishes a land that stopped after storing the commit, and writes its receipt', async () => {
    const { h, user, c, base } = await setup()
    // The first thing a land does after storing an author-built commit is sign its receipt.
    const real = h.ports.signer
    let calls = 0
    h.ports.signer = async () => {
      if (calls++ === 0) throw new Error('stopped here')
      return real()
    }
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    expect(first.res.status).toBe(500)
    expect(first.status.status).toBe('committing')
    expect((await v3.readCommit(h.ports.stores.v3, c.id, 1))?.id).toBe(first.built.id)
    expect(await v3.readReceipt(h.ports.stores.v3, c.id, 1)).toBeNull()

    await recover(h, first.id)
    const after = await json(await h.request(`${base}/uploads/${first.id}`, { user }))
    expect(after).toMatchObject({ status: 'committed', result: { hash: first.built.id } })
    expect(
      (
        await v3.verifyLog(h.ports.stores.v3, c.id, {
          serverKeys: [h.signer.publicKey],
          receipts: true,
        })
      )?.id,
    ).toBe(first.built.id)
    // One version, credited to who pushed it, with what it changed.
    const rows = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      hash: first.built.id,
      pushedBy: user,
      pushSessionId: first.id,
      changes: { added: 1 },
    })
    // And the next commit follows it as usual.
    const second = await push(h, user, base, c.id, first.built, one('a2'), 'minor')
    expect(second.status).toMatchObject({ status: 'committed', result: { semver: 'v1.1.0' } })
  })

  it('fails an upload whose commit text was lost, rather than land a commit built here', async () => {
    const { h, user, c, base } = await setup()
    const internal = h.ports.stores.internal
    const put = internal.put.bind(internal)
    internal.put = async (key, ...rest) => {
      if (key.endsWith('/authored.json')) throw new Error('the write failed')
      return put(key, ...rest)
    }
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    internal.put = put
    expect(first.res.status).toBe(500)
    await recover(h, first.id)
    const after = await json(await h.request(`${base}/uploads/${first.id}`, { user }))
    expect(after).toMatchObject({ status: 'failed', error: { statusCode: 500 } })
    expect(after.error.error).toContain('commit sent with this upload is gone')
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(0)
  })

  it('checks a collection with author-built commits with fsck', async () => {
    const { h, user, c, base } = await setup()
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    await push(h, user, base, c.id, first.built, one('a2'), 'minor')
    await runJob({ type: 'repo.fsck', collectionId: c.id, fileBytes: false }, h.ports)
    await h.drain()
    const report = JSON.parse(
      await (await h.ports.stores.internal.get(`fsck/${c.id}.json`))!.text(),
    )
    // Its description too: the first commit writes it, though it came by upload.
    expect(report.errors).toEqual([])
    expect(report).toMatchObject({ ok: true, versions: 2 })
  })

  it('takes a version only where it is the authority, however it is sent', async () => {
    const { h, user, c, base } = await setup()
    await v3.createCollection(h.ports.stores.v3, c.id, { authority: 'elsewhere.org' })
    const files = await build(firstRows())
    const id = await sendFiles(h, user, base, files)
    // No commit of its author's: a change this server would build the commit for.
    await h.request(`${base}/uploads/${id}/commit`, {
      method: 'POST',
      user,
      json: { files: files.map((f) => f.ref) },
    })
    await h.drain()
    const status = await json(await h.request(`${base}/uploads/${id}`, { user }))
    expect(status).toMatchObject({ status: 'failed', error: { statusCode: 422 } })
    expect(JSON.stringify(status.error)).toContain('elsewhere.org')
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(0)
  })

  it('carries receipts into a fork, so its author-built commits still verify', async () => {
    const { h, user, c, base } = await setup()
    await makePublic(h, c.id)
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    await push(h, user, base, c.id, first.built, one('a2'), 'minor')
    await h.ports.db.insert(schema.user).values({ id: 'u2', name: 'u2', email: 'u2@example.org' })
    await h.ports.db.insert(schema.organization).values({ id: 'org2', name: 'Two', slug: 'two' })
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'org2', userId: 'u2', role: 'owner' })
    const res = await h.request(`${base}/fork`, {
      method: 'POST',
      user: 'u2',
      json: { targetOrg: 'two' },
    })
    expect(res.status).toBe(201)
    const [fork] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.organizationId, 'org2'))
    const store = h.ports.stores.v3
    const description = await v3.readDescription(store, fork!.id)
    const head = await v3.verifyLog(store, fork!.id, {
      lineage: description!.lineage!,
      serverKeys: [h.signer.publicKey],
      receipts: true,
    })
    expect(head?.commit.number).toBe(2)
  })

  it('stops serving a file once a record in it is withheld', async () => {
    const { h, user, c, base } = await setup()
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    const f = first.built.commit.changes[0]!.files[0]!
    // A deny list that names nothing here: the file is read through and found clean.
    await h.ports.db
      .insert(schema.denylist)
      .values({ hash: 'f'.repeat(64), kind: 'record', reason: 'another' })
    forgetDenylist(h.ports.db)
    expect((await h.request(`${base}/record-files/${f.id}`, { user })).status).toBe(200)
    expect((await h.request(`${base}/record-files/${f.id}`, { user })).status).toBe(200)
    const file = await v3.openFile(h.ports.stores.v3, f.id)
    const cursor = new v3.EntryCursor(file.reader({}), 0)
    await cursor.seek()
    let hash = ''
    for (; cursor.current; await cursor.next())
      if (cursor.current.type === 'Author' && cursor.current.hash) hash = cursor.current.hash
    await h.ports.db.insert(schema.denylist).values({ hash, kind: 'record', reason: 'takedown' })
    forgetDenylist(h.ports.db)
    expect((await h.request(`${base}/record-files/${f.id}`, { user })).status).toBe(451)
    // Lifted again, it is served again.
    await h.ports.db.delete(schema.denylist).where(eq(schema.denylist.hash, hash))
    forgetDenylist(h.ports.db)
    expect((await h.request(`${base}/record-files/${f.id}`, { user })).status).toBe(200)
  })

  it('caches a file as it caches a version: ten minutes for anyone, private for members', async () => {
    const { h, user, c, base } = await setup()
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    const f = first.built.commit.changes[0]!.files[0]!
    const control = async (as?: string) =>
      (await h.request(`${base}/record-files/${f.id}`, as ? { user: as } : {})).headers.get(
        'cache-control',
      )
    expect(await control(user)).toBe('private')
    await makePublic(h, c.id)
    expect(await control()).toBe('public, max-age=600, stale-while-revalidate=60')
    expect(await control(user)).toBe('private, max-age=3600')
  })

  it('serves files without reading the log again for each', async () => {
    const { h, user, c, base } = await setup()
    let previous: v3.StoredCommit | null = null
    const files: string[] = []
    for (const [i, rows] of [firstRows(), one('a2'), one('a3')].entries()) {
      const p = await push(h, user, base, c.id, previous, rows, i === 0 ? 'major' : 'minor')
      expect(p.status.status).toBe('committed')
      previous = p.built
      files.push(p.built.commit.changes[0]!.files[0]!.id)
    }
    const store = h.ports.stores.v3
    const get = store.get.bind(store)
    let commitReads = 0
    store.get = async (key, ...rest) => {
      if (key.includes('/commits/')) commitReads++
      return get(key, ...rest)
    }
    try {
      for (const id of files)
        expect((await h.request(`${base}/record-files/${id}`, { user })).status).toBe(200)
      // The first request opens the version (three commits); the others find it kept.
      expect(commitReads).toBeLessThanOrEqual(3)
      // A file no version names costs one fresh look, and is not served.
      const other = await build(one('x'))
      await store.put(v3.recordKey(other[0]!.ref.id), other[0]!.bytes)
      expect((await h.request(`${base}/record-files/${other[0]!.ref.id}`, { user })).status).toBe(
        404,
      )
    } finally {
      store.get = get
    }
  })

  it('pages commits by count and by size, and refuses numbers that are not whole', async () => {
    const { h, user, c, base } = await setup()
    let previous: v3.StoredCommit | null = null
    for (const [i, rows] of [firstRows(), one('a2'), one('a3')].entries()) {
      const p = await push(h, user, base, c.id, previous, rows, i === 0 ? 'major' : 'minor')
      previous = p.built
    }
    const page = async (q: string) => json(await h.request(`${base}/commits${q}`, { user }))
    expect(await page('')).toMatchObject({ head: 3, more: false, commits: [{}, {}, {}] })
    const two = await page('?limit=2')
    expect(two).toMatchObject({ more: true, commits: [{ number: 1 }, { number: 2 }] })
    expect(await page('?after=2&limit=2')).toMatchObject({ more: false, commits: [{ number: 3 }] })
    expect(await page('?after=3')).toMatchObject({ head: 3, more: false, commits: [] })
    // Each commit comes with its receipt.
    expect(two.commits.map((x: any) => x.receipt.number)).toEqual([1, 2])
    for (const q of ['?after=0.5', '?after=-1', '?after=x', '?limit=0', '?limit=1.5'])
      expect((await h.request(`${base}/commits${q}`, { user })).status).toBe(400)
    expect((await h.request(`${base}/commits/1.5`, { user })).status).toBe(400)
    // A page stops at its size in commit text too, but always gives one.
    const bytes = commitPage.bytes
    commitPage.bytes = 1
    try {
      expect(await page('')).toMatchObject({ more: true, commits: [{ number: 1 }] })
      expect(await page('?after=1')).toMatchObject({ more: true, commits: [{ number: 2 }] })
    } finally {
      commitPage.bytes = bytes
    }
  })

  it('answers a range of no bytes as one it cannot satisfy', async () => {
    const { h, user, c, base } = await setup()
    const first = await push(h, user, base, c.id, null, firstRows(), 'major')
    const f = first.built.commit.changes[0]!.files[0]!
    const ranged = (range: string) =>
      h.request(`${base}/record-files/${f.id}`, { user, headers: { range } })
    expect((await ranged('bytes=-0')).status).toBe(416)
    const last = await ranged('bytes=-4')
    expect(last.status).toBe(206)
    expect((await last.arrayBuffer()).byteLength).toBe(4)
  })
})
