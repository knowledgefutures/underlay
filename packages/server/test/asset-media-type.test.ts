/**
 * An asset's media type is what the collection's records say it is: `mediaType` on the
 * asset reference (docs/protocol/v3.md 5.3) sets the collection's `$asset` row, over the type the
 * bytes were uploaded with. The bytes are shared; each collection's type is its own.
 */
import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { attachment } from '../src/v3/files.js'
import { cleanup, type Harness, harness } from './harness.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)

const sha = (b: string) => createHash('sha256').update(b).digest('hex')
const json = async (r: Response) => (await r.json()) as any
const Doc = { type: 'object', properties: { title: { type: 'string' }, cover: {} } }

async function collection(h: Harness, slug: string) {
  const c = await h.collection(slug)
  await h.ports.db
    .update(schema.collections)
    .set({ public: true })
    .where(eq(schema.collections.id, c.id))
  return `/api/collections/org/${slug}`
}

async function push(h: Harness, user: string, base: string, records: object[]) {
  const open = await json(
    await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Doc } } }),
  )
  await h.request(`${base}/push/${open.session_id}/records`, {
    method: 'POST',
    user,
    ndjson: records,
  })
  const res = await h.request(`${base}/push/${open.session_id}/commit`, { method: 'POST', user })
  await h.drain()
  expect(res.status).toBe(201)
}

const listed = async (h: Harness, user: string, base: string) =>
  Object.fromEntries(
    (await json(await h.request(`${base}/versions/latest/assets`, { user }))).map(
      (a: { hash: string; mediaType: string | null }) => [a.hash, a.mediaType],
    ),
  )

const doc = (id: string, hash: string, cover: object = {}) => ({
  id,
  type: 'Doc',
  data: { title: id, cover: { $asset: `ul:asset:${hash}`, ...cover } },
})

describe('asset file names', () => {
  it('saves a download under the name a reference gives, or its hash', () => {
    const h = 'a'.repeat(64)
    expect(attachment(h)).toBe(`attachment; filename="${h}"`)
    expect(attachment(h, 'cover.png')).toBe(
      `attachment; filename="cover.png"; filename*=UTF-8''cover.png`,
    )
    expect(attachment(h, 'Résumé "v2".pdf')).toBe(
      `attachment; filename="R_sum_ _v2_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22v2%22.pdf`,
    )
  })
})

describe.skipIf(!onV3)('asset media types', () => {
  it('takes the type the records declare, per collection', async () => {
    const h = await harness()
    const user = await h.member()
    const a = await collection(h, 'a')
    const b = await collection(h, 'b')
    const png = 'png bytes'
    const plain = 'plain bytes'
    for (const base of [a, b])
      for (const bytes of [png, plain])
        expect(
          (
            await h.request(`${base}/assets/${sha(bytes)}`, {
              method: 'PUT',
              user,
              headers: { 'content-type': 'application/octet-stream' },
              body: bytes,
            })
          ).status,
        ).toBe(201)

    // A declared type sets the row; without one, the upload's type stands.
    await push(h, user, a, [
      doc('one', sha(png), { mediaType: 'image/png', fileName: 'cover.png' }),
      doc('two', sha(plain)),
    ])
    expect(await listed(h, user, a)).toEqual({
      [sha(png)]: 'image/png',
      [sha(plain)]: 'application/octet-stream',
    })
    const head = await h.request(`${a}/assets/${sha(png)}`, { method: 'HEAD', user })
    expect(head.headers.get('content-type')).toBe('image/png')

    // Another collection holding the same bytes says its own type; the first's is unchanged.
    await push(h, user, b, [doc('one', sha(png), { mediaType: 'image/x-portable' })])
    expect((await listed(h, user, b))[sha(png)]).toBe('image/x-portable')
    expect((await listed(h, user, a))[sha(png)]).toBe('image/png')

    // A held asset takes a newly declared type; a malformed one declares nothing.
    await push(h, user, a, [
      doc('one', sha(png), { mediaType: 'image/webp' }),
      doc('two', sha(plain), { mediaType: 'not a type' }),
    ])
    expect(await listed(h, user, a)).toEqual({
      [sha(png)]: 'image/webp',
      [sha(plain)]: 'application/octet-stream',
    })
  })
})
