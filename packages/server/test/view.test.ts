import {
  type Change,
  compareUtf8,
  hashRecord,
  hashSchema,
  type RecordEntry,
  utf8ByteLength,
} from '@underlay/core'
import { afterAll, describe, expect, it } from 'vitest'

import { commitVersion } from '../src/versions/commit.js'
import { getRecord, loadView, typeRecords } from '../src/versions/view.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const Author = { type: 'object' }
const up = (id: string, n: number): Change<RecordEntry> => {
  const { hash, canonical } = hashRecord(id, 'Author', { n })
  return { key: id, entry: { key: id, hash, size: utf8ByteLength(canonical), body: canonical } }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('version views', () => {
  it('pages owners across both sets by offset and by key, and hides private records from others', async () => {
    const h = await harness()
    const c = await h.collection()
    const ids = Array.from(
      { length: 2500 },
      (_, i) => `id${String((i * 7919) % 2500).padStart(5, '0')}`,
    )
    const isPrivate = (id: string) => Number(id.slice(2)) % 3 === 0
    const sort = (cs: Change<RecordEntry>[]) => cs.sort((a, b) => compareUtf8(a.key, b.key))
    const r = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [
        {
          slug: 'Author',
          schema: Author,
          schemaHash: hashSchema(Author),
          public: sort(ids.filter((id) => !isPrivate(id)).map((id, i) => up(id, i))),
          private: sort(ids.filter(isPrivate).map((id, i) => up(id, i))),
        },
      ],
      metadata: null,
    })
    if (r.status !== 'committed') throw new Error(r.status)
    const repo = await h.ports.stores.forCollection(c.id)
    const owner = await loadView(repo, r.version, true)
    const reader = await loadView(repo, r.version, false)
    const all = [...ids].sort(compareUtf8)
    const pub = all.filter((id) => !isPrivate(id))
    expect(owner.types[0]!.count).toBe(2500)
    expect(reader.types[0]!.count).toBe(pub.length)

    for (const offset of [0, 1, 833, 834, 1250, 2499, 2500]) {
      const page = (await collect(typeRecords(owner, owner.types[0]!, { offset })))
        .slice(0, 3)
        .map((e) => e.key)
      expect(page).toEqual(all.slice(offset, offset + 3))
    }
    for (const offset of [0, 5, 1000, pub.length - 1]) {
      const page = (await collect(typeRecords(reader, reader.types[0]!, { offset })))
        .slice(0, 3)
        .map((e) => e.key)
      expect(page).toEqual(pub.slice(offset, offset + 3))
    }
    const afterKey = await collect(typeRecords(owner, owner.types[0]!, { after: all[99]! }))
    expect(afterKey[0]!.key).toBe(all[100])

    const secret = all.find(isPrivate)!
    expect((await getRecord(owner, owner.types[0]!, secret))?.set).toBe('private')
    expect(await getRecord(reader, reader.types[0]!, secret)).toBe(null)
    const visible = await getRecord(reader, reader.types[0]!, pub[0]!)
    expect(JSON.parse(visible!.body!).id).toBe(pub[0])
  })
})
