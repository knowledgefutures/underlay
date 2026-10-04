import { createHash } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import * as schema from '../src/db/schema.js'
import { memoryRateLimiter } from '../src/lib/limits.js'
import { cleanup, harness } from './harness.js'
import { setup } from './kf-app.js'

afterAll(cleanup)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** A tar archive's regular files by name (ustar; pax headers skipped). */
function untar(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>()
  const text = (a: number, b: number) =>
    new TextDecoder().decode(bytes.subarray(a, b)).replace(/\0.*$/s, '')
  for (let at = 0; at + 512 <= bytes.length;) {
    const name = text(at, at + 100)
    if (!name) break
    const size = parseInt(text(at + 124, at + 136).trim(), 8)
    const kind = text(at + 156, at + 157)
    if (kind === '0' || kind === '')
      out.set(name, new TextDecoder().decode(bytes.subarray(at + 512, at + 512 + size)))
    at += 512 + Math.ceil(size / 512) * 512
  }
  return out
}
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: { type: 'object' } } }

describe('rate limits', () => {
  it('budgets /api/* per IP and per user, not counting a page’s own API calls', async () => {
    const h = await harness()
    const ports = { ...h.ports, rateLimit: memoryRateLimiter({ anon: 3, user: 5 }) }
    const app = createApp(() => ({
      ports,
      config: { appUrl: 'http://test', deployment: 'test' },
      authenticate: async (req) => {
        const user = req.headers.get('x-test-user')
        return user ? { userId: user, scope: 'session', collectionIds: null } : null
      },
      // A page that makes four API calls of its own.
      renderPage: async (req, api) => {
        for (let i = 0; i < 4; i++) await api(new Request('http://test/api/health', req))
        return new Response('page')
      },
    }))
    const get = (path: string, headers: Record<string, string> = {}) =>
      app.fetch(new Request(`http://test${path}`, { headers }))
    const ip = (a: string) => ({ 'cf-connecting-ip': a })

    expect((await get('/somepage', ip('1.1.1.1'))).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await get('/api/health', ip('1.1.1.1'))).status).toBe(200)
    const limited = await get('/api/health', ip('1.1.1.1'))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect((await get('/api/health', ip('2.2.2.2'))).status).toBe(200)

    // Signed in, the budget is the user's, wherever they are.
    for (let i = 0; i < 5; i++) {
      expect((await get('/api/health', { ...ip('1.1.1.1'), 'x-test-user': 'u1' })).status).toBe(200)
    }
    expect((await get('/api/health', { 'x-test-user': 'u1' })).status).toBe(429)
    // The rightmost forwarded hop is the address, not the client-written leftmost.
    const fwd = (v: string) => ({ 'x-forwarded-for': v })
    for (let i = 0; i < 3; i++)
      expect((await get('/api/health', fwd(`9.9.9.${i}, 3.3.3.3`))).status).toBe(200)
    expect((await get('/api/health', fwd('9.9.9.9, 3.3.3.3'))).status).toBe(429)
  })
})

describe('denylist and abuse reports', () => {
  it('withholds blocked files and records everywhere they are served', async () => {
    const { h, call, user } = await setup()
    await user('u1') // a steward in the fake KF Auth
    const owner = await h.member('u1')
    await h.collection('docs')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/docs'
    const bad = 'bad bytes'
    const good = 'good bytes'
    for (const b of [bad, good]) {
      await h.request(`${base}/files/${sha(b)}`, { method: 'PUT', user: owner, body: b })
    }
    const open = await h.request(`${base}/push`, {
      method: 'POST',
      user: owner,
      json: { schemas: { Doc } },
    })
    const sid = (await open.json()).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user: owner,
      ndjson: [
        { id: 'a', type: 'Doc', data: { title: 'Spam', pdf: { $file: `sha256:${sha(bad)}` } } },
        { id: 'b', type: 'Doc', data: { title: 'Fine', pdf: { $file: `sha256:${sha(good)}` } } },
      ],
    })
    expect(
      (await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user: owner })).status,
    ).toBe(201)
    const listing = async () =>
      ((await (await call(`${base}/versions/latest/records?type=Doc`)).json()).records ?? []) as {
        id: string
        hash: string
      }[]
    const spam = (await listing()).find((r) => r.id === 'a')!

    // Anyone may report; only stewards see reports or change the denylist.
    expect(
      (await call('/api/abuse-reports', { method: 'POST', json: { reason: 'spam' } })).status,
    ).toBe(400)
    const report = await call('/api/abuse-reports', {
      method: 'POST',
      json: { hash: `sha256:${sha(bad)}`, reason: 'spam file', contact: 'x@example.org' },
    })
    expect(report.status).toBe(201)
    const { id: reportId } = await report.json()
    await user('u2')
    expect((await call('/api/admin/abuse-reports', { user: 'u2' })).status).toBe(403)
    const open1 = await (await call('/api/admin/abuse-reports', { user: 'u1' })).json()
    expect(open1.reports.map((r: { id: string }) => r.id)).toEqual([reportId])
    const block = (json: unknown, u = 'u1') =>
      call('/api/admin/denylist', { method: 'POST', user: u, json })
    expect((await block({ hash: sha(bad), kind: 'file', reason: 'x' }, 'u2')).status).toBe(403)
    expect((await block({ hash: 'nope', kind: 'file', reason: 'x' })).status).toBe(400)

    expect((await call(`${base}/files/${sha(bad)}`)).status).toBe(302)
    expect((await block({ hash: sha(bad), kind: 'file', reason: 'spam' })).status).toBe(201)
    expect((await block({ hash: spam.hash, kind: 'record', reason: 'spam' })).status).toBe(201)

    // The block resolved the report.
    expect((await (await call('/api/admin/abuse-reports', { user: 'u1' })).json()).reports).toEqual(
      [],
    )

    // Files: the redirect, the global route and presign all refuse it.
    expect((await call(`${base}/files/${sha(bad)}`)).status).toBe(451)
    expect((await call(`/api/collections/files/${sha(bad)}`)).status).toBe(451)
    const presigned = await (
      await call(`${base}/files/presign`, {
        method: 'POST',
        json: { hashes: [sha(bad), sha(good)] },
      })
    ).json()
    expect(presigned[sha(bad)]).toBeNull()
    expect(presigned[sha(good)]).toEqual(expect.any(String))
    // Records: listings and NDJSON leave it out; the batch read returns nothing for it.
    expect((await listing()).map((r) => r.id)).toEqual(['b'])
    const ndjson = await (await call(`${base}/versions/latest/records.ndjson`)).text()
    expect(ndjson).toContain('Fine')
    expect(ndjson).not.toContain('Spam')
    const batch = await (
      await call('/api/records/batch', { method: 'POST', json: { hashes: [spam.hash] } })
    ).text()
    expect(batch).toBe('')
    // Export: the archive is whole, the record left out and the file listed as withheld.
    const tar = untar(new Uint8Array(await (await call(`${base}/export?format=tar`)).arrayBuffer()))
    const lines = tar.get('records/Doc.ndjson')!.trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['b'])
    expect(tar.has(`files/${sha(bad)}`)).toBe(false)
    expect(tar.get(`files/${sha(good)}`)).toBe(good)
    const manifest = JSON.parse(tar.get('manifest.json')!)
    expect(manifest.files_withheld).toEqual([sha(bad)])
    expect(manifest.version.recordCount).toBe(1)

    // Unblocking serves it again.
    expect(
      (await call(`/api/admin/denylist/${sha(bad)}`, { method: 'DELETE', user: 'u1' })).status,
    ).toBe(200)
    expect((await call(`${base}/files/${sha(bad)}`)).status).toBe(302)
    const entries = (await (await call('/api/admin/denylist', { user: 'u1' })).json()).entries
    expect(entries.map((e: { kind: string }) => e.kind)).toEqual(['record'])
  })

  it('lets stewards dismiss a report', async () => {
    const { call, user } = await setup()
    await user('u1')
    const r = await call('/api/abuse-reports', {
      method: 'POST',
      json: { url: 'https://example.org/x', reason: 'phishing' },
    })
    const { id } = await r.json()
    const patch = (status: string) =>
      call(`/api/admin/abuse-reports/${id}`, { method: 'PATCH', user: 'u1', json: { status } })
    expect((await patch('blocked')).status).toBe(400)
    expect((await patch('dismissed')).status).toBe(200)
    const dismissed = await (
      await call('/api/admin/abuse-reports?status=dismissed', { user: 'u1' })
    ).json()
    expect(dismissed.reports).toEqual([expect.objectContaining({ id, resolvedBy: 'u1' })])
  })
})
