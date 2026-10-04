import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: {} } }

async function json(res: Response) {
  return (await res.json()) as any
}

describe('files', () => {
  it('uploads small files through the API, verifying the hash', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('docs')
    const base = '/api/collections/org/docs'
    const bytes = 'hello file'
    let res = await h.request(`${base}/files/${'0'.repeat(64)}`, {
      method: 'PUT',
      user,
      body: bytes,
    })
    expect(res.status).toBe(400)
    res = await h.request(`${base}/files/sha256:${sha(bytes)}`, {
      method: 'PUT',
      user,
      body: bytes,
      headers: { 'content-type': 'text/html' },
    })
    expect(res.status).toBe(201)
    const [f] = await h.ports.db.select().from(schema.files)
    // HTML is stored as inert bytes; the key is the canonical repository key.
    expect(f).toMatchObject({
      hash: sha(bytes),
      size: 10,
      mimeType: 'application/octet-stream',
      storageKey: `repo/files/${sha(bytes)}`,
    })
    expect(h.bucket.objects.has(`repo/files/${sha(bytes)}`)).toBe(true)
  })

  it('presigns multipart parts a page at a time, within 10,000 parts and 5 TiB', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('docs')
    const base = '/api/collections/org/docs'
    const start = (size: number) =>
      h.request(`${base}/files/uploads`, { method: 'POST', user, json: { hash: sha('big'), size } })
    const GiB = 1024 ** 3
    const big = await json(await start(50 * GiB))
    expect(big).toMatchObject({ partBytes: 100 * 1024 ** 2, partCount: 512 })
    expect(big.parts).toHaveLength(100)
    expect(big.parts[99].partNumber).toBe(100)
    const next = await json(
      await h.request(`${base}/files/uploads/${big.id}/parts?from=101`, { user }),
    )
    expect(next.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual(
      Array.from({ length: 100 }, (_, i) => 101 + i),
    )
    const tail = await json(
      await h.request(`${base}/files/uploads/${big.id}/parts?from=501`, { user }),
    )
    expect(tail.parts).toHaveLength(12)
    // The largest file takes bigger parts, never more than 10,000 of them.
    const most = await json(await start(5 * 1024 * GiB))
    expect(most.partCount).toBeLessThanOrEqual(10_000)
    expect(most.partBytes * most.partCount).toBeGreaterThanOrEqual(5 * 1024 * GiB)
    expect(most.parts).toHaveLength(100)
    expect((await start(5 * 1024 * GiB + 1)).status).toBe(413)
  })

  it('verifies direct uploads in a job and copies them to the canonical key', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('docs')
    const base = '/api/collections/org/docs'
    const good = new TextEncoder().encode('x'.repeat(100_000))
    let res = await h.request(`${base}/files/uploads`, {
      method: 'POST',
      user,
      json: { hash: sha(good), size: good.length, mimeType: 'application/pdf' },
    })
    expect(res.status).toBe(201)
    const ticket = await json(res)
    expect(ticket.url).toBeTruthy()
    // The client PUTs to the presigned URL; in tests, write the staging key directly.
    await h.bucket.put(`internal/uploads/${ticket.id}`, good)
    res = await h.request(`${base}/files/uploads/${ticket.id}/complete`, {
      method: 'POST',
      user,
      json: {},
    })
    expect(res.status).toBe(202)
    await h.drain()
    expect(
      (await json(await h.request(`${base}/files/uploads/${ticket.id}`, { user }))).status,
    ).toBe('verified')
    expect(h.bucket.objects.has(`repo/files/${sha(good)}`)).toBe(true)
    expect(h.bucket.objects.has(`internal/uploads/${ticket.id}`)).toBe(false)

    // Bytes that don't match the declared hash are refused and removed.
    const bad = await json(
      await h.request(`${base}/files/uploads`, {
        method: 'POST',
        user,
        json: { hash: sha('other'), size: 3 },
      }),
    )
    await h.bucket.put(`internal/uploads/${bad.id}`, 'abc')
    await h.request(`${base}/files/uploads/${bad.id}/complete`, { method: 'POST', user, json: {} })
    await h.drain()
    const status = await json(await h.request(`${base}/files/uploads/${bad.id}`, { user }))
    expect(status).toMatchObject({ status: 'failed' })
    expect(status.error).toMatch(/Hash mismatch/)
    expect(
      (
        await h.ports.db
          .select()
          .from(schema.files)
          .where(eq(schema.files.hash, sha('other')))
      ).length,
    ).toBe(0)
  })

  it("doesn't let a commit reference another collection's file without uploading it", async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('v')
    await h.collection('a')
    await h.ports.db.update(schema.collections).set({ public: true })
    const elsewhere = 'bytes only collection v has'
    expect(
      (
        await h.request(`/api/collections/org/v/files/${sha(elsewhere)}`, {
          method: 'PUT',
          user,
          body: elsewhere,
        })
      ).status,
    ).toBe(201)

    const base = '/api/collections/org/a'
    const attempt = async (hash: string) => {
      const sid = (
        await json(
          await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Doc } } }),
        )
      ).session_id
      await h.request(`${base}/push/${sid}/records`, {
        method: 'POST',
        user,
        ndjson: [{ id: 'd', type: 'Doc', data: { pdf: { $file: `sha256:${hash}` } } }],
      })
      const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
      return { status: res.status, body: JSON.stringify(await json(res)).replaceAll(hash, 'H') }
    }
    const existing = await attempt(sha(elsewhere))
    const nowhere = await attempt(sha('bytes nobody has'))
    // Same refusal either way: the answer says nothing about other collections.
    expect(existing.status).toBe(422)
    expect(existing).toEqual(nowhere)
    expect((await h.request(`${base}/files/${sha(elsewhere)}`)).status).toBe(404)

    // Uploading the bytes under this collection is the proof that lets it commit.
    expect(
      (await h.request(`${base}/files/${sha(elsewhere)}`, { method: 'PUT', user, body: elsewhere }))
        .status,
    ).toBe(201)
    expect((await attempt(sha(elsewhere))).status).toBe(201)
    expect((await h.request(`${base}/files/${sha(elsewhere)}`)).status).toBe(302)
  })

  it('serves files by redirect only to those who may read them', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('docs')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/docs'
    const pub = 'public pdf bytes'
    const priv = 'private pdf bytes'
    for (const b of [pub, priv]) {
      expect(
        (await h.request(`${base}/files/${sha(b)}`, { method: 'PUT', user, body: b })).status,
      ).toBe(201)
    }
    const sid = (
      await json(
        await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Doc } } }),
      )
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [
        { id: 'd1', type: 'Doc', data: { title: 'Public', pdf: { $file: `sha256:${sha(pub)}` } } },
        {
          id: 'd2',
          type: 'Doc',
          data: { title: 'Private', pdf: { $file: `sha256:${sha(priv)}` } },
          private: true,
        },
        { id: 'd3', type: 'Doc', data: { title: 'Again', pdf: { $file: `sha256:${sha(pub)}` } } },
        {
          id: 'd4',
          type: 'Doc',
          data: { title: 'Hidden', pdf: { $file: `sha256:${sha(pub)}` } },
          private: true,
        },
      ],
    })
    expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      201,
    )

    const anonPub = await h.request(`${base}/files/${sha(pub)}`)
    expect(anonPub.status).toBe(302)
    expect(anonPub.headers.get('location')).toContain(`repo/files/${sha(pub)}`)
    expect((await h.request(`${base}/files/${sha(priv)}`)).status).toBe(404)
    expect((await h.request(`${base}/files/${sha(priv)}`, { user })).status).toBe(302)
    expect(
      (await h.request(`${base}/files/${sha(pub)}`, { method: 'HEAD' })).headers.get(
        'content-length',
      ),
    ).toBe(String(pub.length))

    // The files listing follows the same sets.
    const anonList = await json(await h.request(`${base}/versions/latest/files`))
    expect(anonList.map((f: any) => f.hash)).toEqual([sha(pub)])
    const ownerList = await json(await h.request(`${base}/versions/latest/files`, { user }))
    expect(ownerList.length).toBe(2)
    // Reference counts follow the sets too: private references only for members.
    const countsOf = (list: any[]) =>
      Object.fromEntries(list.map((f: any) => [f.hash, f.referenceCount]))
    expect(countsOf(anonList)).toEqual({ [sha(pub)]: 2 })
    expect(countsOf(ownerList)).toEqual({ [sha(pub)]: 3, [sha(priv)]: 1 })
    void c
  })

  it('counts the file references of records stored out of line', async () => {
    // Over 64 KB, a record's body is a pointer when written but the full JSON
    // when read back, so its references must be counted through the pointer.
    const h = await harness()
    const user = await h.member()
    await h.collection('docs')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/docs'
    const pdf = 'large record pdf'
    await h.request(`${base}/files/${sha(pdf)}`, { method: 'PUT', user, body: pdf })
    const big = (title: string) => ({
      id: 'big',
      type: 'Doc',
      data: { title: title + 'x'.repeat(70_000), pdf: { $file: `sha256:${sha(pdf)}` } },
    })
    const push = async (open: object, records: object[], deletes: object[] = []) => {
      const sid = (
        await json(await h.request(`${base}/push`, { method: 'POST', user, json: open }))
      ).session_id
      if (records.length)
        await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
      if (deletes.length)
        await h.request(`${base}/push/${sid}/deletes`, { method: 'POST', user, ndjson: deletes })
      const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
      expect(res.status).toBe(201)
      return json(res)
    }
    const files = async () =>
      (await json(await h.request(`${base}/versions/latest/files`))).map((f: any) => f.hash)

    await push({ schemas: { Doc } }, [big('First')])
    expect(await files()).toEqual([sha(pdf)])
    // Changing the record moves the count -1 and +1: it used to go negative here.
    await push({ base: 'v1.0.0' }, [big('Second')])
    expect(await files()).toEqual([sha(pdf)])
    // Deleting it takes the file out of the set.
    const v = await push({ base: 'v1.1.0' }, [], [{ type: 'Doc', id: 'big' }])
    expect(v.semver).toBeTruthy()
    expect(await files()).toEqual([])
  })
})
