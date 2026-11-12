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
    if (lines.length)
      await h.request(`${path}/push/${sid}/${kind}`, { method: 'POST', user, ndjson: lines })
  }
  const commit = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
  expect(commit.status).toBe(201)
}

describe.skipIf(!onV3)('record pages by offset', () => {
  it('start from the offset index, built in chunks and moved forward by each commit', async () => {
    const step = offsetConfig.step
    const chunk = offsetConfig.walkChunk
    offsetConfig.step = 100
    offsetConfig.walkChunk = 700
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
      const third = JSON.parse(await (await index(3))!.text()) as { points: [number, string][] }
      expect(third.points.some(([pos]) => pos % 100 !== 0)).toBe(true)
      expect(await index(1)).toBe(null)
      for (const o of [0, 799, 800, 801, 1500, 2997])
        expect(await page(o)).toEqual(ids.slice(o, o + 5))
    } finally {
      offsetConfig.step = step
      offsetConfig.walkChunk = chunk
    }
  })
})
