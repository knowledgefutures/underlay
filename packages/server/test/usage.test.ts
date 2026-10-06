import { createHash } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  isolateUsageSink,
  newUsageBuffer,
  rebuildUsageDay,
  rebuildUsageStep,
  usageBatch,
  type UsageEvent,
  usageFor,
  writeUsage,
} from '../src/billing/usage.js'
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
    const listBytes = (await list.arrayBuffer()).byteLength
    expect((await h.request(`${base}/files/${sha(pdf)}`)).status).toBe(302)
    await h.request('/api/health') // not a collection: nothing billed

    const of = (m: string) => seen.filter((e) => e.m === m)
    expect(of('api_calls')).toHaveLength(2)
    expect(of('file_downloads')).toEqual([expect.objectContaining({ n: 1, c: c.id, a: 'org1' })])
    expect(of('file_bytes')[0]!.n).toBe(pdf.length)
    // Counted as the body streamed out.
    expect(of('response_bytes').map((e) => e.n)).toContain(listBytes)
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

    // A response the client abandons still counts its call, and its bytes so far.
    seen.length = 0
    const gone = await h.request(`${base}/versions/latest/records.ndjson`)
    await gone.body!.cancel()
    expect(of('api_calls')).toHaveLength(1)
    // records.ndjson.gz bills the NDJSON it decompresses to, not the gzip bytes.
    seen.length = 0
    const gz = await h.request(`${base}/versions/latest/records.ndjson.gz`)
    const wire = (await gz.arrayBuffer()).byteLength
    const billed = of('response_bytes')[0]!.n
    const ndjson = await (await h.request(`${base}/versions/latest/records.ndjson`)).text()
    expect(billed).not.toBe(wire)
    // Canonical lines, without the `,"hash":…` (74 bytes) records.ndjson adds.
    expect(billed).toBe(new TextEncoder().encode(ndjson).byteLength - 74)
  })

  it('sends an isolate’s events in batches, and writes them directly when sending fails', async () => {
    const h = await harness()
    const buffer = newUsageBuffer()
    const sent: UsageEvent[][] = []
    const written: UsageEvent[][] = []
    const waits: Promise<unknown>[] = []
    let failing = false
    const sink = isolateUsageSink(
      buffer,
      (p) => waits.push(p),
      async (events) => {
        if (failing) throw new Error('queue down')
        sent.push(events)
      },
      async (events) => void written.push(events),
    )
    const ev = (r: string): UsageEvent => ({
      r,
      i: 0,
      t: Date.now(),
      a: 'org1',
      c: 'c',
      m: 'api_calls',
      n: 1,
    })
    usageBatch.flushMs = 10
    try {
      for (let i = 0; i < 5; i++) sink.record([ev(`r${i}`)])
      await Promise.all(waits)
      expect(sent.map((b) => b.length)).toEqual([5])
      // A full buffer goes at once.
      usageBatch.maxEvents = 3
      sink.record([ev('a'), ev('b'), ev('c')])
      await Promise.all(waits)
      expect(sent.map((b) => b.length)).toEqual([5, 3])
      failing = true
      sink.record([ev('x')])
      await Promise.all(waits)
      expect(written.map((b) => b.map((e) => e.r))).toEqual([['x']])
    } finally {
      usageBatch.flushMs = 5_000
      usageBatch.maxEvents = 400
    }

    // A day rebuilds a listing page per step.
    const day = new Date().toISOString().slice(0, 10)
    for (let i = 0; i < 3; i++) await writeUsage(h.ports, [ev(`d${i}`)])
    expect(await rebuildUsageStep(h.ports, day, 0)).toBeNull()
    expect((await usageFor(h.ports, day, 'org1'))[0]!.amount).toBe(3)
  })
})
