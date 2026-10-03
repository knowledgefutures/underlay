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
    void c
  })
})
