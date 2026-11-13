import { describe, expect, it } from 'vitest'
import { afterAll } from 'vitest'

import { offsetConfig } from '../src/v3/offsets.js'
import { cleanup, type Harness, harness } from './harness.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }
const id = (i: number) => `a${String(i).padStart(5, '0')}`

async function push(h: Harness, user: string, path: string, open: object, body: object) {
  const res = await h.request(`${path}/push`, { method: 'POST', user, json: open })
  const sid = ((await res.json()) as { session_id: string }).session_id
  for (const [kind, lines] of Object.entries(body) as [string, unknown[]][]) {
    if (lines.length) {
      const res = await h.request(`${path}/push/${sid}/${kind}`, {
        method: 'POST',
        user,
        ndjson: lines,
      })
      if (!res.ok) throw new Error(`${kind}: ${res.status} ${await res.text()}`)
    }
  }
  const commit = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
  expect(commit.status).toBe(201)
}

describe.skipIf(!onV3)('record pages by offset', () => {
  it('start from the offset index, walked in ranges and moved forward by each commit', async () => {
    const step = offsetConfig.step
    const ranges = offsetConfig.rangeRecords
    offsetConfig.step = 100
    offsetConfig.rangeRecords = 700
    try {
      const h = await harness()
      const user = await h.member()
      const c = await h.collection('pages', { recordLayout: 'v3' })
      const path = '/api/collections/org/pages'
      let ids = Array.from({ length: 3000 }, (_, i) => id(i * 2))
      await push(
        h,
        user,
        path,
        { schemas: { Author } },
        {
          records: ids.map((x, i) => ({ id: x, type: 'Author', data: { n: i } })),
        },
      )
      await h.drain()
      const page = async (offset: number) => {
        const res = await h.request(
          `${path}/versions/latest/records?type=Author&limit=5&offset=${offset}`,
          { user },
        )
        return ((await res.json()) as { records: { id: string }[] }).records.map((r) => r.id)
      }
      const index = (seq: number) =>
        h.ports.stores.internal.get(`v3-offsets/${c.id}/${seq}/Author.json`)
      expect(await index(1)).not.toBe(null)
      // Walked in more than one range: positions restart where a range does.
      const first = JSON.parse(await (await index(1))!.text()) as { points: [number, string][] }
      expect(first.points.some(([pos]) => pos % 100 !== 0)).toBe(true)
      for (const o of [0, 99, 100, 101, 1234, 2995, 2999, 3000])
        expect(await page(o)).toEqual(ids.slice(o, o + 5))

      // Records added before and among the points, some removed (one of them a point):
      // the next version's index is the previous one moved forward.
      const added = [id(1), id(201), id(4001)]
      const removed = [id(0), id(400), id(5998)]
      await push(
        h,
        user,
        path,
        {},
        {
          records: added.map((x) => ({ id: x, type: 'Author', data: { n: -1 } })),
          deletes: removed.map((x) => ({ id: x, type: 'Author' })),
        },
      )
      await h.drain()
      ids = [...ids.filter((x) => !removed.includes(x)), ...added].sort()
      expect(await index(2)).not.toBe(null)
      for (const o of [0, 1, 99, 100, 150, 1999, 2000, 2996])
        expect(await page(o)).toEqual(ids.slice(o, o + 5))

      // One record added mid-type: moved forward, not walked again (a walk puts every point
      // at a multiple of the step); the index two versions back is dropped.
      await push(
        h,
        user,
        path,
        {},
        {
          records: [{ id: id(3001), type: 'Author', data: { n: -2 } }],
        },
      )
      await h.drain()
      ids = [...ids, id(3001)].sort()
      const second = JSON.parse(await (await index(2))!.text()) as { points: [number, string][] }
      const third = JSON.parse(await (await index(3))!.text()) as { points: [number, string][] }
      // The same records indexed, each moved by the one record added before it or not.
      expect(third.points.map(([, id]) => id)).toEqual(second.points.map(([, id]) => id))
      third.points.forEach(([pos], i) => expect(pos - second.points[i]![0]).toBeOneOf([0, 1]))
      expect(third.points.some(([pos], i) => pos !== second.points[i]![0])).toBe(true)
      expect(await index(1)).toBe(null)
      for (const o of [0, 799, 800, 801, 1500, 2997])
        expect(await page(o)).toEqual(ids.slice(o, o + 5))
    } finally {
      offsetConfig.step = step
      offsetConfig.rangeRecords = ranges
    }
  })
})

describe.skipIf(!onV3)('a page far into a type with no index yet', () => {
  it('answers that it is being indexed, then pages once it is', async () => {
    const saved = { ...offsetConfig }
    offsetConfig.step = 100
    offsetConfig.walkCap = 500
    try {
      const h = await harness()
      const user = await h.member()
      await h.collection('far', { recordLayout: 'v3' })
      const path = '/api/collections/org/far'
      const ids = Array.from({ length: 2000 }, (_, i) => id(i))
      await push(
        h,
        user,
        path,
        { schemas: { Author } },
        {
          records: ids.map((x, i) => ({ id: x, type: 'Author', data: { n: i } })),
        },
      )
      // Within the cap a page walks; past it, 503 and a retry, or `preparing` on the web's call.
      const near = await h.request(
        `${path}/versions/latest/records?type=Author&limit=5&offset=400`,
        { user },
      )
      expect(near.status).toBe(200)
      const far = await h.request(
        `${path}/versions/latest/records?type=Author&limit=5&offset=1500`,
        { user },
      )
      expect(far.status).toBe(503)
      expect(far.headers.get('retry-after')).toBe('60')
      const detail = (await (
        await h.request(`${path}/versions/latest?records=Author&limit=5&offset=1500`, { user })
      ).json()) as { recordsPage: { preparing?: boolean; records: unknown[] } }
      expect(detail.recordsPage).toMatchObject({ preparing: true, records: [] })
      await h.drain()
      const after = await h.request(
        `${path}/versions/latest/records?type=Author&limit=5&offset=1500`,
        { user },
      )
      expect(
        ((await after.json()) as { records: { id: string }[] }).records.map((r) => r.id),
      ).toEqual(ids.slice(1500, 1505))
    } finally {
      Object.assign(offsetConfig, saved)
    }
  })
})

describe('a records page', () => {
  it('sends each value cut to what a cell shows, and the record whole on its own page', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('wide')
    const path = '/api/collections/org/wide'
    const Wide = {
      type: 'object',
      properties: {
        t: { type: 'string' },
        refs: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } },
        n: { type: 'integer' },
      },
    }
    const data = {
      t: 'x'.repeat(5000),
      refs: Array.from({ length: 300 }, (_, i) => ({ n: i })),
      n: 7,
    }
    await push(
      h,
      user,
      path,
      { schemas: { Wide } },
      { records: [{ id: 'w1', type: 'Wide', data }] },
    )
    const page = (await (
      await h.request(`${path}/versions/latest?records=Wide&preview=1`, { user })
    ).json()) as { recordsPage: { records: { data: any; preview?: boolean }[] } }
    const r = page.recordsPage.records[0]!
    expect(r.preview).toBe(true)
    expect(r.data.t).toHaveLength(201)
    expect(r.data.t.endsWith('…')).toBe(true)
    expect(r.data.refs.$preview).toHaveLength(201)
    expect(r.data.n).toBe(7)
    const whole = (await (
      await h.request(`${path}/versions/latest?records=Wide`, { user })
    ).json()) as { recordsPage: { records: { data: any }[] } }
    expect(whole.recordsPage.records[0]!.data).toEqual(data)
  })
})
