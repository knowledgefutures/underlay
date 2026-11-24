/**
 * The API's asset names (`…/assets/…`, `assetCount`, `needed_assets`, …). The file names
 * clients first used are gone: their routes don't answer, a push naming its assets `files`
 * is refused, and responses carry only the asset names. The v3 upload API's
 * sorted-record-files are `record-files` and `record_files` only.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { memoryStore, v3 } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { withAssetNames } from '../src/lib/asset-names.js'
import { cleanup, type Harness, harness, outboundCalls, respondOutbound } from './harness.js'
import { attach, onV3 } from './layouts.js'

afterAll(cleanup)

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')
const json = async (r: Response) => (await r.json()) as Record<string, any>
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: {} } }

async function setup() {
  const h = await harness()
  const user = await h.member()
  const c = await h.collection('lib')
  await h.ports.db
    .update(schema.collections)
    .set({ public: true })
    .where(eq(schema.collections.id, c.id))
  return { h, user, c, base: '/api/collections/org/lib' }
}

/** Open a session with `body`, send records, commit: the open and commit responses. */
async function push(h: Harness, user: string, base: string, body: object, records: object[]) {
  const opened = await h.request(`${base}/push`, { method: 'POST', user, json: body })
  if (opened.status !== 200)
    return { opened, open: await json(opened), res: undefined, body: {} as Record<string, any> }
  const open = await json(opened)
  await h.request(`${base}/push/${open.session_id}/records`, {
    method: 'POST',
    user,
    ndjson: records,
  })
  const res = await h.request(`${base}/push/${open.session_id}/commit`, { method: 'POST', user })
  await h.drain()
  return { opened, open, res, body: await json(res), sid: open.session_id as string }
}

/** A request at an asset path (status, location, body); its old files path doesn't answer. */
async function both(h: Harness, user: string | undefined, assets: string, init: RequestInit = {}) {
  const files = assets.replace('/assets', '/files')
  expect(files).not.toBe(assets)
  const answer = async (path: string) => {
    const res = await h.request(path, { ...init, ...(user ? { user } : {}) })
    const text = await res.text()
    return { status: res.status, location: res.headers.get('location'), text }
  }
  const a = await answer(assets)
  const old = await answer(files)
  expect(old.status).toBe(404)
  expect(old.location).toBeNull()
  return a
}

describe('asset names', () => {
  it('answers at each asset route, and not at its old files route', async () => {
    const { h, user, base } = await setup()
    const bytes = 'asset bytes'
    let res = await h.request(`${base}/assets/${sha(bytes)}`, {
      method: 'PUT',
      user,
      body: bytes,
    })
    expect(res.status).toBe(201)
    expect(await json(res)).toEqual({ hash: sha(bytes), status: 'stored', size: bytes.length })
    const other = 'other bytes'
    expect(
      (await h.request(`${base}/files/${sha(other)}`, { method: 'PUT', user, body: other })).status,
    ).toBe(404)
    expect(
      (await h.request(`${base}/assets/${sha(other)}`, { method: 'PUT', user, body: other }))
        .status,
    ).toBe(201)
    // A bad hash is refused at either path, in the asset wording.
    res = await h.request(`${base}/assets/${'0'.repeat(64)}`, { method: 'PUT', user, body: 'x' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Hash mismatch')
    res = await h.request(`${base}/assets/nope`, { method: 'PUT', user, body: 'x' })
    expect((await json(res)).error).toBe('Not a sha256 asset hash')

    // A multipart body sends its part as "asset".
    const multipart = async (parts: string[]) => {
      const form = new FormData()
      for (const p of parts) form.append(p, new File([bytes], 'a.txt', { type: 'text/plain' }))
      const encoded = new Response(form)
      return h.request(`${base}/assets/${sha(bytes)}`, {
        method: 'PUT',
        user,
        headers: { 'content-type': encoded.headers.get('content-type')! },
        body: await encoded.arrayBuffer(),
      })
    }
    expect((await multipart(['asset'])).status).toBe(201)
    expect((await json(await multipart(['file'])))?.error).toBe('No asset in multipart body')
    expect((await json(await multipart(['other'])))?.error).toBe('No asset in multipart body')

    // A version holding both, so v3 lists them too (its assets are the version's).
    const committed = await push(
      h,
      user,
      base,
      { schemas: { Doc }, assets: { add: [sha(other)] } },
      [{ id: 'd', type: 'Doc', data: { title: 'D', pdf: attach(sha(bytes)) } }],
    )
    expect(committed.res!.status).toBe(201)

    // GET and HEAD.
    for (const h0 of [sha(bytes), sha(other)])
      expect((await both(h, user, `${base}/assets/${h0}`)).status).toBe(302)
    expect((await both(h, user, `${base}/assets/${sha(bytes)}`, { method: 'HEAD' })).status).toBe(
      200,
    )
    const missing = await both(h, user, `${base}/assets/${sha('never')}`)
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.text).error).toBe('Asset not found')
    expect((await both(h, user, `${base}/assets/${sha('never')}`, { method: 'HEAD' })).status).toBe(
      404,
    )
    // Presign.
    const presigned = await both(h, user, `${base}/assets/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: [sha(bytes), sha('never')] }),
    })
    expect(JSON.parse(presigned.text)).toMatchObject({
      [sha(bytes)]: expect.any(String),
      [sha('never')]: null,
    })
    // The version's assets.
    const listed = await both(h, user, `${base}/versions/latest/assets`)
    expect(
      JSON.parse(listed.text)
        .map((f: { hash: string }) => f.hash)
        .sort(),
    ).toEqual([sha(bytes), sha(other)].sort())
    expect((await both(h, user, `${base}/versions/v9.9.9/assets`)).status).toBe(404)
    // From any collection the caller may read, through the reference log.
    await h.drain()
    const global = await both(h, user, `/api/collections/assets/${sha(bytes)}`)
    if (!onV3) expect(global.status).toBe(302)
    expect((await both(h, user, '/api/collections/assets/not-a-hash')).status).toBe(404)
  })

  it('runs direct uploads at the asset paths', async () => {
    const { h, user, base } = await setup()
    const good = new TextEncoder().encode('x'.repeat(100_000))
    let res = await h.request(`${base}/assets/uploads`, {
      method: 'POST',
      user,
      json: { hash: sha(good), size: good.length, mediaType: 'application/pdf' },
    })
    expect(res.status).toBe(201)
    const ticket = await json(res)
    await h.bucket.put(`internal/uploads/${ticket.id}`, good)
    res = await h.request(`${base}/assets/uploads/${ticket.id}/complete`, {
      method: 'POST',
      user,
      json: {},
    })
    expect(res.status).toBe(202)
    await h.drain()
    const status = await both(h, user, `${base}/assets/uploads/${ticket.id}`)
    expect(
      (await h.request(`${base}/files/uploads`, { method: 'POST', user, json: {} })).status,
    ).toBe(404)
    expect(JSON.parse(status.text).status).toBe('verified')

    // Parts, a page at a time, for a multipart upload.
    const big = await json(
      await h.request(`${base}/assets/uploads`, {
        method: 'POST',
        user,
        json: { hash: sha('big'), size: 50 * 1024 ** 3 },
      }),
    )
    const parts = await both(h, user, `${base}/assets/uploads/${big.id}/parts?from=101`)
    expect(JSON.parse(parts.text).parts[0].partNumber).toBe(101)
    res = await h.request(`${base}/assets/uploads/${big.id}/complete`, {
      method: 'POST',
      user,
      json: {},
    })
    expect(res.status).toBe(400)
    res = await h.request(`${base}/assets/uploads`, {
      method: 'POST',
      user,
      json: { hash: sha('huge'), size: 5 * 1024 ** 4 + 1 },
    })
    expect(res.status).toBe(413)
    expect((await json(res)).error).toBe('An asset is at most 5 TiB')
  })

  it('takes "assets" in a push, refuses "files", and answers with the asset names', async () => {
    const { h, user, c, base } = await setup()
    const have = 'held bytes'
    await h.request(`${base}/assets/${sha(have)}`, { method: 'PUT', user, body: have })
    // The old name: refused, not ignored.
    const old = await push(h, user, base, { schemas: { Doc }, files: { add: [sha(have)] } }, [])
    expect(old.opened.status).toBe(400)
    expect(old.open.error).toBe('Name the assets "assets", not "files"')

    // Missing: the session says which, and so does the refusal.
    const record = { id: 'd', type: 'Doc', data: { title: 'D' } }
    const r = await push(
      h,
      user,
      base,
      { schemas: { Doc }, assets: { add: [sha(have), sha('never')] } },
      [record],
    )
    expect(r.open.needed_assets).toEqual([sha('never')])
    expect(r.open).not.toHaveProperty('needed_files')
    expect(r.open.limits.asset_bytes).toBeGreaterThan(0)
    expect(r.open.limits).not.toHaveProperty('file_bytes')
    expect(r.res!.status).toBe(422)
    expect(r.body).toEqual({
      error: 'Missing files',
      assetsNeeded: [sha('never')],
      statusCode: 422,
    })
    const refused = await json(await h.request(`${base}/push/${r.sid}`, { user }))
    expect(refused.error.assetsNeeded).toEqual([sha('never')])
    expect(refused.error).not.toHaveProperty('filesNeeded')

    // Committed: the version's count under its asset name only, wherever a version is shown.
    const done = await push(h, user, base, { schemas: { Doc }, assets: { add: [sha(have)] } }, [
      record,
    ])
    expect(done.res!.status).toBe(201)
    const counted = (o: Record<string, any>, n: number) => {
      expect(o.assetCount).toBe(n)
      expect(o).not.toHaveProperty('fileCount')
      expect(o).not.toHaveProperty('publicFileCount')
    }
    counted(done.body, 1)
    const status = await json(await h.request(`${base}/push/${done.sid}`, { user }))
    counted(status.result, 1)
    // Committing again answers with what was recorded.
    counted(
      await json(await h.request(`${base}/push/${done.sid}/commit`, { method: 'POST', user })),
      1,
    )

    counted((await json(await h.request(`${base}/versions`, { user })))[0], 1)
    const detail = await json(await h.request(`${base}/versions/latest`, { user }))
    counted(detail, 1)
    counted((await json(await h.request(base, { user }))).latestVersion, 1)
    const explore = await json(await h.request('/api/collections', { user }))
    counted(
      explore.collections.find((x: { id: string }) => x.id === c.id),
      1,
    )

    // The manifest's list, and a diff's counts.
    const manifest = await json(await h.request(`${base}/versions/latest/manifest`, { user }))
    expect(manifest.assets).toEqual([sha(have)])
    expect(manifest).not.toHaveProperty('files')
    const since = await json(
      await h.request(`${base}/versions/latest/manifest?since=${detail.semver}`, { user }),
    )
    expect(since.assets).toEqual([sha(have)])
    expect(since).not.toHaveProperty('files')
    const removed = await push(
      h,
      user,
      base,
      { base: detail.semver, assets: { remove: [sha(have)] } },
      [],
    )
    counted(removed.body, 0)
    const diff = await json(await h.request(`${base}/versions/latest/diff`, { user }))
    expect(diff.meta).toMatchObject({ assetsRemoved: 1, assetsAdded: 0 })
    expect(diff.meta).not.toHaveProperty('filesRemoved')
    expect(diff.meta).not.toHaveProperty('filesAdded')
  })

  it('answers a body stored under the old names with the asset names', () => {
    expect(withAssetNames({ semver: 'v1.0.0', fileCount: 3 })).toEqual({
      semver: 'v1.0.0',
      assetCount: 3,
    })
    expect(withAssetNames({ error: 'Missing files', filesNeeded: ['a'] })).toEqual({
      error: 'Missing files',
      assetsNeeded: ['a'],
    })
    // One stored with both keeps its asset name's value; anything else is as it was.
    expect(withAssetNames({ fileCount: 1, assetCount: 2 })).toEqual({ assetCount: 2 })
    expect(withAssetNames(null)).toBeNull()
  })

  it('names assets in the export manifest', async () => {
    const { h, user, base } = await setup()
    const have = 'export bytes'
    await h.request(`${base}/assets/${sha(have)}`, { method: 'PUT', user, body: have })
    const done = await push(h, user, base, { schemas: { Doc }, assets: { add: [sha(have)] } }, [
      { id: 'd', type: 'Doc', data: { title: 'D' } },
    ])
    expect(done.res!.status).toBe(201)
    const res = await h.request(`${base}/export?format=tar`, { user })
    expect(res.status).toBe(200)
    const dir = await mkdtemp(join(tmpdir(), 'ul-assets-'))
    await writeFile(join(dir, 'a.tar'), new Uint8Array(await res.arrayBuffer()))
    execFileSync('tar', ['-xf', 'a.tar'], { cwd: dir })
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.version.assetCount).toBe(1)
    expect(manifest.version).not.toHaveProperty('fileCount')
    expect(manifest).toMatchObject({ assets_missing: [], assets_withheld: [] })
    expect(manifest).not.toHaveProperty('files_missing')
    expect(manifest).not.toHaveProperty('files_withheld')
  })

  it('sends assetCount in a webhook payload', async () => {
    const { h, user, base } = await setup()
    const hook = await h.request(`${base}/webhooks`, {
      method: 'POST',
      user,
      json: { url: 'https://hooks.example.org/u', bumpFilter: ['major'] },
    })
    expect(hook.status).toBe(201)
    outboundCalls.length = 0
    respondOutbound(() => new Response('ok'))
    expect(
      (await push(h, user, base, { schemas: { Doc } }, [{ id: 'd', type: 'Doc', data: {} }])).res!
        .status,
    ).toBe(201)
    await h.drain()
    const sent = JSON.parse(String(outboundCalls[0]!.init.body))
    expect(sent.version.assetCount).toBe(0)
    expect(sent.version).not.toHaveProperty('fileCount')
  })

  it('resolves a ul:asset: link to the asset path', async () => {
    const { h, c } = await setup()
    const hex = sha('linked')
    const res = await h.request(`/api/links/resolve?to=ul:asset:${hex}&collection=${c.id}`, {
      headers: { accept: 'application/json' },
    })
    expect(await json(res)).toEqual({ url: `/api/collections/_/${c.id}/assets/${hex}` })
  })
})

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

describe.skipIf(!onV3)('v3 uploads: record-files and record_files', () => {
  const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

  it('takes sorted-record-files at record-files and in record_files only', async () => {
    const h = await harness({ newCollections: 'v3' })
    const user = await h.member()
    await h.collection('lib', { recordLayout: 'v3' })
    const base = '/api/collections/org/lib'
    const files = await build([
      v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author),
      v3.rowFromRecord('a1', 'Author', { name: 'Ada' }),
    ])
    const opened = await json(
      await h.request(`${base}/uploads`, { method: 'POST', user, json: {} }),
    )
    expect(opened.limits.record_files).toBeGreaterThan(0)
    expect(opened.limits.max_record_file_bytes).toBeGreaterThan(0)
    expect(opened.limits).not.toHaveProperty('files')
    expect(opened.limits).not.toHaveProperty('max_file_bytes')
    const id = opened.upload_id as string
    for (const f of files) {
      const res = await json(
        await h.request(`${base}/uploads/${id}/record-files`, {
          method: 'POST',
          user,
          json: { id: f.ref.id, size: f.bytes.byteLength },
        }),
      )
      await h.bucket.put(String(res.url).replace('memory://put/', ''), f.bytes)
    }
    // The complete route is at record-files only (this body is not a multipart's).
    const complete = (seg: string) =>
      h.request(`${base}/uploads/${id}/${seg}/${files[0]!.ref.id}/complete`, {
        method: 'POST',
        user,
        json: {},
      })
    let res = await complete('record-files')
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Needs {upload_id, parts: [{n, etag}]}')
    expect((await complete('files')).status).toBe(404)
    const old = await h.request(`${base}/uploads/${id}/files`, {
      method: 'POST',
      user,
      json: { id: files[0]!.ref.id, size: files[0]!.bytes.byteLength },
    })
    expect(old.status).toBe(404)
    const commit = (body: object) =>
      h.request(`${base}/uploads/${id}/commit`, { method: 'POST', user, json: body })
    const refs = files.map((f) => f.ref)
    res = await commit({ files: refs })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('"record_files" must be a non-empty list')
    res = await commit({ record_files: [] })
    expect((await json(res)).error).toBe('"record_files" must be a non-empty list')
    res = await commit({ record_files: refs })
    expect([201, 202]).toContain(res.status)
    await h.drain()
    const status = await json(await h.request(`${base}/uploads/${id}`, { user }))
    expect(status).toMatchObject({ status: 'committed', record_files_named: refs.length })
    expect(status).not.toHaveProperty('files_named')
    expect(status).not.toHaveProperty('files_verified')
    expect(status.result.assetCount).toBe(0)
    expect(status.result).not.toHaveProperty('fileCount')
  })
})
