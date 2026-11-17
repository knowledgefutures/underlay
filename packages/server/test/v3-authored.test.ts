/**
 * Phase 0 of the Underlay CLI (local-tool-build.md): commits built by their author and
 * stored unchanged, receipts beside every commit, a collection's authority, a client-chosen
 * collection id, and the routes that follow a collection's log and fetch its files.
 */
import { memoryStore, v3 } from '@underlay/protocol'
import { afterAll, describe, expect, it } from 'vitest'

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
) {
  const files = await build(rows)
  const change = await v3.makeChange(cid, {
    files: files.map((f) => f.ref),
    base: previous?.id ?? null,
    message: 'from here',
  })
  const built = await v3.buildCommit({ collection: cid, previous, change, bump })
  const id = await sendFiles(h, user, base, files)
  const res = await h.request(`${base}/uploads/${id}/commit`, {
    method: 'POST',
    user,
    json: { files: files.map((f) => f.ref), commit: dec.decode(built.bytes) },
  })
  await h.drain()
  const status = await json(await h.request(`${base}/uploads/${id}`, { user }))
  return { built, res, status }
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
    expect(receipt).toMatchObject({ number: 1, version: first.built.id, server: 'test' })
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
    expect(log.commits[1].receipt.version).toBe(second.built.id)
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
    expect(commits[0]!.commit).toMatchObject({ number: 2, previous: first.built.id })
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
    const old = await v3.buildCommit({
      collection: c.id,
      previous: first.built,
      change: await v3.makeChange(c.id, { files: files.map((f) => f.ref) }),
      bump: 'minor',
      createdAt: new Date(Date.now() - 3600_000),
    })
    const res2 = await h.request(`${base}/uploads/${id}/commit`, {
      method: 'POST',
      user,
      json: { files: files.map((f) => f.ref), commit: dec.decode(old.bytes) },
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
