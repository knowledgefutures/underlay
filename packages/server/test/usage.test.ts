import { createHash } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { rebuildUsageDay, type UsageEvent, usageFor, writeUsage } from '../src/billing/usage.js'
import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: { type: 'object' } } }

describe('usage', () => {
  it('meters collection API calls and downloads to the collection’s owner', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('docs')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/docs'
    const pdf = 'pdf bytes!'
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
        { id: 'a', type: 'Doc', data: { title: 'A', pdf: { $file: `sha256:${sha(pdf)}` } } },
      ],
    })
    await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })

    const seen: UsageEvent[] = []
    h.ports.usage = { record: (events) => void seen.push(...events) }
    const list = await h.request(`${base}/versions/latest/records`)
    expect(list.status).toBe(200)
    expect((await h.request(`${base}/files/${sha(pdf)}`)).status).toBe(302)
    await h.request('/api/health') // not a collection: nothing billed

    const of = (m: string) => seen.filter((e) => e.m === m)
    expect(of('api_calls')).toHaveLength(2)
    expect(of('file_downloads')).toEqual([expect.objectContaining({ n: 1, c: c.id, a: 'org1' })])
    expect(of('file_bytes')[0]!.n).toBe(pdf.length)
    expect(seen.every((e) => e.a === 'org1' && e.c === c.id)).toBe(true)
    // Each request's events share its id, numbered from 0.
    const ids = new Set(seen.map((e) => e.r))
    expect(ids.size).toBe(2)

    // Landed: the log and the rollups. A retried batch counts twice in the rollups
    // until the day is rebuilt from the log.
    await writeUsage(h.ports, seen)
    await writeUsage(h.ports, seen)
    const day = new Date(seen[0]!.t).toISOString().slice(0, 10)
    const calls = async () =>
      (await usageFor(h.ports, day, 'org1')).find((r) => r.metric === 'api_calls')?.amount
    expect(await calls()).toBe(4)
    expect(await rebuildUsageDay(h.ports, day)).toBe(seen.length)
    expect(await calls()).toBe(2)
  })
})
