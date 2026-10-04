import { getEntry, hashRecord, recordTree, RepoSource } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { limits } from '../src/push/session.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const Author = {
  type: 'object',
  properties: { name: { type: 'string' }, born: { type: 'integer' } },
  required: ['name'],
}

const rec = (id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'Author',
  data,
  ...extra,
})
const hashOf = (id: string, data: unknown) => hashRecord(id, 'Author', data).hash

async function setup() {
  const h = await harness()
  const user = await h.member()
  const c = await h.collection('authors')
  return { h, user, c, base: '/api/collections/org/authors' }
}

async function json(res: Response) {
  return (await res.json()) as Record<string, any>
}

async function head(h: Harness, collectionId: string) {
  const [c] = await h.ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  if (!c?.headVersionId) return null
  const [v] = await h.ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.id, c.headVersionId))
  return v!
}

describe('delta push', () => {
  it('parses a records batch as it streams in, across any chunk boundaries', async () => {
    const { h, user, base, c } = await setup()
    const open = await h.request(`${base}/push`, {
      method: 'POST',
      user,
      json: { schemas: { Author } },
    })
    const sid = ((await open.json()) as { session_id: string }).session_id
    const body = new TextEncoder().encode(
      [rec('a', { name: 'Zoë' }), rec('b', { name: '日本語' }), rec('c', { name: 'C' })]
        .map((r) => JSON.stringify(r))
        .join('\n'), // no trailing newline
    )
    // Three-byte chunks: lines and multi-byte characters split everywhere.
    const chunked = (bytes: Uint8Array, size: number) =>
      new ReadableStream<Uint8Array>({
        start(ctl) {
          for (let i = 0; i < bytes.length; i += size) ctl.enqueue(bytes.slice(i, i + size))
          ctl.close()
        },
      })
    const send = (stream: ReadableStream<Uint8Array>) =>
      h.request(`${base}/push/${sid}/records`, {
        method: 'POST',
        user,
        body: stream,
        headers: { 'content-type': 'application/x-ndjson' },
        duplex: 'half',
      } as RequestInit)
    const res = await send(chunked(body, 3))
    expect(await res.json()).toEqual({ received: 3 })
    await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
    const repo = await h.ports.stores.forCollection(c.id)
    const v = await head(h, c.id)
    const root = await repo.root(v!.hash)
    const got = await getEntry(
      new RepoSource(recordTree, repo),
      root.public.types.Author!.root,
      'b',
    )
    expect(got?.hash).toBe(hashOf('b', { name: '日本語' }))

    // Past the cap, with no content-length to refuse it early: 413 mid-stream.
    const open2 = await h.request(`${base}/push`, { method: 'POST', user, json: {} })
    const sid2 = ((await open2.json()) as { session_id: string }).session_id
    const big = new ReadableStream<Uint8Array>({
      pull(ctl) {
        ctl.enqueue(
          new TextEncoder().encode(JSON.stringify(rec('x', { name: 'x'.repeat(1 << 20) })) + '\n'),
        )
      },
    })
    const tooBig = await h.request(`${base}/push/${sid2}/records`, {
      method: 'POST',
      user,
      body: big,
      duplex: 'half',
    } as RequestInit)
    expect(tooBig.status).toBe(413)
  })

  it('caps the sessions one user has in progress', async () => {
    const { h, user, base } = await setup()
    const before = limits.openSessions
    limits.openSessions = 2
    try {
      const open = () =>
        h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Author } } })
      const a = ((await (await open()).json()) as { session_id: string }).session_id
      expect((await open()).status).toBe(200)
      const refused = await open()
      expect(refused.status).toBe(429)
      expect(((await refused.json()) as { error: string }).error).toMatch(/2 push sessions/)
      // Aborting one makes room; another user is unaffected.
      expect(
        (await h.request(`${base}/push/${a}`, { method: 'DELETE', user })).status,
      ).toBeLessThan(300)
      expect((await open()).status).toBe(200)
      const other = await h.member('u2')
      expect(
        (
          await h.request(`${base}/push`, {
            method: 'POST',
            user: other,
            json: { schemas: { Author } },
          })
        ).status,
      ).toBe(200)
    } finally {
      limits.openSessions = before
    }
  })

  it('opens, uploads, deletes and commits', async () => {
    const { h, user, c, base } = await setup()
    let res = await h.request(`${base}/push`, {
      method: 'POST',
      user,
      json: { schemas: { Author }, metadata: { title: 'Authors' } },
    })
    expect(res.status).toBe(200)
    const opened = await json(res)
    // The node advertises its limits (protocol section 11.4).
    expect(opened.limits).toEqual({
      open_bytes: 8 * 1024 * 1024,
      batch_bytes: 16 * 1024 * 1024,
      batch_lines: 10_000,
      session_idle_seconds: 3600,
      open_sessions: 20,
      file_bytes: 32 * 1024 * 1024,
    })
    let sid = opened.session_id
    res = await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [
        rec('ada', { name: 'Ada', born: 1815 }),
        rec('alan', { name: 'Alan' }),
        rec('kurt', { name: 'Kurt' }, { private: true }),
      ],
    })
    expect(await json(res)).toEqual({ received: 3 })
    res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
    expect(res.status).toBe(201)
    const v1 = await json(res)
    expect(v1).toMatchObject({ semver: 'v1.0.0', recordCount: 3 })

    // Second push: base required to match; update, delete, flip one to public.
    res = await h.request(`${base}/push`, { method: 'POST', user, json: { base: 'v0.9.0' } })
    expect(res.status).toBe(409)
    res = await h.request(`${base}/push`, { method: 'POST', user, json: { base: 'v1.0.0' } })
    sid = (await json(res)).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [rec('ada', { name: 'Ada Lovelace', born: 1815 }), rec('kurt', { name: 'Kurt' })],
    })
    await h.request(`${base}/push/${sid}/deletes`, {
      method: 'POST',
      user,
      ndjson: [{ type: 'Author', id: 'alan' }],
    })
    res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
    expect(res.status).toBe(201)
    const v2 = await head(h, c.id)
    expect(v2).toMatchObject({
      semver: 'v1.1.0',
      recordCount: 2,
      publicRecordCount: 2,
      hasPrivate: false,
    })
    const repo = await h.ports.stores.forCollection(c.id)
    const root = await repo.root(v2!.hash)
    // Metadata was kept from the base.
    expect(root.metadata).toEqual({ title: 'Authors' })
    const kurt = await getEntry(
      new RepoSource(recordTree, repo),
      root.public.types.Author!.root,
      'kurt',
    )
    expect(kurt?.hash).toBe(hashOf('kurt', { name: 'Kurt' }))
  })

  it('compacts runs during upload, later uploads still winning', async () => {
    const { h, user, c, base } = await setup()
    const sid = (
      await json(
        await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
      )
    ).session_id
    // 40 uploads over 10 ids: each id is rewritten, and a few are deleted then re-added.
    for (let i = 0; i < 40; i++) {
      const id = `a${i % 10}`
      const path = i % 7 === 3 ? 'deletes' : 'records'
      const res = await h.request(`${base}/push/${sid}/${path}`, {
        method: 'POST',
        user,
        ndjson: [path === 'deletes' ? { type: 'Author', id } : rec(id, { name: `n${i}` })],
      })
      expect(res.status).toBe(200)
      await h.drain()
    }
    const runs = await h.ports.db
      .select()
      .from(schema.pushRuns)
      .where(eq(schema.pushRuns.sessionId, sid))
    expect(runs.some((r) => r.tier === 1)).toBe(true)
    expect(runs.length).toBeLessThan(40)
    expect(runs.every((r) => r.mergingInto === null)).toBe(true)
    const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
    expect(res.status).toBe(201)
    // The last write to each id wins: a delete for i % 7 === 3, else the record.
    const last = new Map<string, number>()
    for (let i = 0; i < 40; i++) last.set(`a${i % 10}`, i)
    const repo = await h.ports.stores.forCollection(c.id)
    const root = await repo.root((await head(h, c.id))!.hash)
    const source = new RepoSource(recordTree, repo)
    for (const [id, i] of last) {
      const e = await getEntry(source, root.public.types.Author!.root, id)
      expect(e?.hash ?? null).toBe(i % 7 === 3 ? null : hashOf(id, { name: `n${i}` }))
    }
  })

  it('reports invalid records by line, and the input rules', async () => {
    const { h, user, base } = await setup()
    const sid = (
      await json(
        await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
      )
    ).session_id
    const res = await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      body: [
        JSON.stringify(rec('ok', { name: 'Fine' })),
        JSON.stringify(rec('bad', { born: 'x' })),
        '{"id":"dup","type":"Author","data":{"name":"a","name":"b"}}',
        '{"id":"big","type":"Author","data":{"name":"n","born":12345678901234567890}}',
        JSON.stringify(rec('extra', { name: 'E', nickname: 'e' })),
      ].join('\n'),
    })
    expect(res.status).toBe(422)
    const body = await json(res)
    expect(body.totalErrors).toBe(4)
    expect(body.validationErrors.map((e: { line: number }) => e.line)).toEqual([2, 3, 4, 5])
    expect(body.validationErrors[1].errors[0]).toMatch(/duplicate_key/)
    expect(body.validationErrors[2].errors[0]).toMatch(/unsafe_integer/)
  })

  it('commits asynchronously as a job', async () => {
    const { h, user, base } = await setup()
    const sid = (
      await json(
        await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
      )
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [rec('a', { name: 'A' })],
    })
    const res = await h.request(`${base}/push/${sid}/commit?async=true`, { method: 'POST', user })
    expect(res.status).toBe(202)
    expect((await json(await h.request(`${base}/push/${sid}`, { user }))).status).toBe('committing')
    await h.drain()
    const status = await json(await h.request(`${base}/push/${sid}`, { user }))
    expect(status).toMatchObject({ status: 'committed', result: { semver: 'v1.0.0' } })
  })

  it('keeps writes to members, and private collections hidden', async () => {
    const { h, base } = await setup()
    expect((await h.request(`${base}/push`, { method: 'POST', json: {} })).status).toBe(404)
    await h.ports.db.update(schema.collections).set({ public: true })
    expect((await h.request(`${base}/push`, { method: 'POST', json: {} })).status).toBe(401)
    expect(
      (await h.request(`${base}/push`, { method: 'POST', user: 'stranger', json: {} })).status,
    ).toBe(403)
  })
})
