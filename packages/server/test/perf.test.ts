import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { afterAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: { type: 'object' } } }

async function setup() {
  const h = await harness()
  const user = await h.member()
  await h.collection('docs')
  await h.ports.db.update(schema.collections).set({ public: true })
  const base = '/api/collections/org/docs'
  const pdf = 'pdf'
  await h.request(`${base}/files/${sha(pdf)}`, { method: 'PUT', user, body: pdf })
  const sid = (
    (await (
      await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Doc } } })
    ).json()) as {
      session_id: string
    }
  ).session_id
  await h.request(`${base}/push/${sid}/records`, {
    method: 'POST',
    user,
    ndjson: [
      ...Array.from({ length: 3000 }, (_, i) => ({
        id: `d${String(i).padStart(4, '0')}`,
        type: 'Doc',
        data: { title: `T${i}` },
      })),
      // Over 64 KB: stored out of line, so its leaf is re-encoded.
      {
        id: 'big',
        type: 'Doc',
        data: { title: 'x'.repeat(70_000), pdf: { $file: `sha256:${sha(pdf)}` } },
      },
    ],
  })
  await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  return { h, user, base, pdf }
}

describe('page performance', () => {
  it('serves a type as concatenated gzip bodies, matching records.ndjson', async () => {
    const { h, base } = await setup()
    const ndjson = (
      await (await h.request(`${base}/versions/latest/records.ndjson?type=Doc`)).text()
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const { hash: _, ...rest } = JSON.parse(l) as Record<string, unknown>
        return JSON.stringify(rest)
      })
    const res = await h.request(`${base}/versions/latest/records.ndjson.gz?type=Doc`)
    expect(res.headers.get('content-type')).toBe('application/gzip')
    const lines = gunzipSync(Buffer.from(await res.arrayBuffer()))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines).toHaveLength(3001)
    expect(lines).toEqual(ndjson)
    // A blocked record is left out.
    const blocked = sha(lines[5]!)
    await h.ports.db
      .insert(schema.denylist)
      .values({ hash: blocked, kind: 'record', reason: 'test' })
    const { forgetDenylist } = await import('../src/lib/limits.js')
    forgetDenylist(h.ports.db)
    const again = gunzipSync(
      Buffer.from(
        await (await h.request(`${base}/versions/latest/records.ndjson.gz`)).arrayBuffer(),
      ),
    )
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
    expect(again).toHaveLength(3000)
    expect(again).not.toContain(lines[5])
    expect((await h.request(`${base}/versions/latest/records.ndjson.gz?type=Nope`)).status).toBe(
      404,
    )
  })

  it('lets a published version be cached, but not latest', async () => {
    const { h, user, base, pdf } = await setup()
    const cc = async (path: string, u?: string) =>
      (await h.request(path, u ? { user: u } : {})).headers.get('cache-control')
    expect(await cc(`${base}/versions/v1.0.0/records?type=Doc`)).toMatch(/^public, max-age=600/)
    expect(await cc(`${base}/versions/v1.0.0`)).toMatch(/^public/)
    expect(await cc(`${base}/versions/v1.0.0/records?type=Doc`, user)).toBe('private, max-age=3600')
    expect(await cc(`${base}/versions/latest/records?type=Doc`)).toBeNull()
    expect(await cc(`${base}/versions/v9.9.9`)).toBeNull()
    expect(await cc(`${base}/files/${sha(pdf)}`)).toBe('private, max-age=240')
  })

  it('authenticates a page once for all its in-process API calls', async () => {
    const h = await harness()
    let calls = 0
    const app = createApp(() => ({
      ports: h.ports,
      config: { appUrl: 'http://test', deployment: 'test' },
      authenticate: async () => {
        calls++
        return null
      },
      renderPage: async (req, api) => {
        for (let i = 0; i < 3; i++) await api(new Request('http://test/api/health', req))
        return new Response('page')
      },
    }))
    await app.fetch(new Request('http://test/some/page'))
    expect(calls).toBe(1)
  })
})
