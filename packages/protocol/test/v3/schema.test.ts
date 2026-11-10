/** Checking an upload: file structure, schemas, and the semver that follows. */
import { describe, expect, it } from 'vitest'

import { jcs, memoryStore, type MemoryStore, sha256Hex, v3 } from '../../src/index.js'
import { rec, rem } from './helpers.js'

const workSchema = {
  type: 'object',
  properties: { title: { type: 'string' }, year: { type: 'integer' } },
  required: ['title'],
}

/** Build rows into files and check and commit them, as a server does with an upload. */
async function upload(
  store: MemoryStore,
  rows: v3.WriteRow[],
  opts: v3.CheckOptions & v3.BuildOptions = {},
) {
  const sorted = rows
    .map((r) => {
      if (r.kind === 'w') throw new Error('no line')
      return r
    })
    .sort(v3.compareKey)
  const files = await v3.buildFiles(sorted, v3.storeTarget(store), opts)
  const refs = files.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ref)
  return v3.commitUpload(store, 'c', { files: refs }, opts)
}

const work = (id: string, data: unknown) => rec('work', id, data)
const schema = (type: string, body: unknown) => rec('$schema', type, body)

describe('semver from the kinds of rows', () => {
  it('is major for a schema change, minor for records, patch for metadata and assets', async () => {
    const store = memoryStore()
    const first = await upload(store, [schema('work', workSchema), work('a', { title: 'A' })])
    expect(first.commit.semver).toBe('v1.0.0')
    expect(first.check).toMatchObject({ bump: 'major', schemasChanged: ['work'], validated: 1 })

    expect((await upload(store, [work('b', { title: 'B', year: 2024 })])).commit.semver).toBe(
      'v1.1.0',
    )
    expect((await upload(store, [rem('work', 'b')])).commit.semver).toBe('v1.2.0')
    expect((await upload(store, [rec('$meta', 'collection', { name: 'X' })])).commit.semver).toBe(
      'v1.2.1',
    )
    await store.put(`assets/${sha256Hex('img')}`, 'img')
    const asset = rec('$asset', sha256Hex('img'), { size: 3, mediaType: 'image/png' })
    expect((await upload(store, [asset])).commit.semver).toBe('v1.2.2')
    // A new type is a new schema row: major.
    const added = await upload(store, [
      schema('author', { type: 'object' }),
      rec('author', 'x', {}),
    ])
    expect(added.commit.semver).toBe('v2.0.0')
    // The same schema sent again is not a change.
    const again = await upload(store, [schema('work', workSchema), work('c', { title: 'C' })])
    expect(again.commit.semver).toBe('v2.1.0')
    expect(again.check.schemasChanged).toEqual([])
    expect((await upload(store, [schema('work', workSchema)])).commit.semver).toBe('v2.1.1')
    await v3.verifyLog(store, 'c', { files: true })
  })
})

describe('validating records', () => {
  it('refuses a record that fails its schema, and commits nothing', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema), work('a', { title: 'A' })])
    await expect(upload(store, [work('b', { year: 2024 })])).rejects.toThrow(v3.UploadError)
    await expect(upload(store, [work('b', { title: 5 })])).rejects.toThrow(/work "b"/)
    // The schema in the same upload is the one that applies.
    await expect(
      upload(store, [
        schema('work', { ...workSchema, required: ['title', 'year'] }),
        work('z', { title: 'Z' }),
      ]),
    ).rejects.toThrow(/work "z"/)
    expect(await v3.headNumber(store, 'c')).toBe(1)
  })

  it('refuses records of a type with no schema, and a schema that is not acceptable', async () => {
    const store = memoryStore()
    await expect(upload(store, [rec('book', 'a', {})])).rejects.toThrow(
      /"book" has records but no schema/,
    )
    await expect(upload(store, [schema('book', { type: 'nonsense' })])).rejects.toThrow(/book/)
    await expect(
      upload(store, [schema('book', { properties: { a: { private: true } } })]),
    ).rejects.toThrow(/private/)
    expect(await v3.headNumber(store, 'c')).toBe(0)
  })

  it('collects several problems, up to a limit', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema)])
    const bad = Array.from({ length: 30 }, (_, i) => work(`w${i}`, { year: 1 }))
    const err = (await upload(store, bad, { maxProblems: 7 }).catch((e) => e)) as v3.UploadError
    expect(err).toBeInstanceOf(v3.UploadError)
    expect(err.problems.length).toBe(7)
  })

  it('checks reserved rows: an asset must be stored and well described', async () => {
    const store = memoryStore()
    const hash = sha256Hex('bytes')
    const row = rec('$asset', hash, { size: 5, mediaType: null })
    await expect(upload(store, [row])).rejects.toThrow(/not stored/)
    await store.put(`assets/${hash}`, 'bytes')
    await upload(store, [row])
    await expect(upload(store, [rec('$asset', hash, { size: 'big' })])).rejects.toThrow(/size/)
    await expect(upload(store, [rec('$meta', 'collection', 'text')])).rejects.toThrow(/object/)
  })

  it('validates without re-verifying files from a trusted builder', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema), work('a', { title: 'A' })], { verify: false })
    await expect(upload(store, [work('b', {})], { verify: false })).rejects.toThrow(/work "b"/)
    const ok = await upload(store, [work('b', { title: 'B' })], { verify: false })
    expect(ok.check.validated).toBe(1)
    // With validation off as well, anything well formed is committed.
    await upload(store, [work('c', {})], { verify: false, validate: false })
  })
})

describe('changing a schema', () => {
  async function loaded() {
    const store = memoryStore()
    const rows = [
      schema('work', workSchema),
      schema('other', { type: 'object' }),
      rec('other', 'o', {}),
    ]
    for (let i = 0; i < 50; i++)
      rows.push(work(`w${String(i).padStart(2, '0')}`, { title: `T${i}`, year: 2000 + i }))
    rows.push(work('old', { title: 'no year' }))
    await upload(store, rows)
    return store
  }

  it('does not read the records for a change that only relaxes', async () => {
    const store = await loaded()
    const relaxed = { ...workSchema, required: [], title: 'Works' }
    const r = await upload(store, [schema('work', relaxed)])
    expect(r.check).toMatchObject({ bump: 'major', schemasChanged: ['work'], scanned: 0 })
    expect(r.commit.semver).toBe('v2.0.0')
  })

  it('scans the type when a change could reject records, and refuses if one fails', async () => {
    const store = await loaded()
    const stricter = { ...workSchema, required: ['title', 'year'] }
    await expect(upload(store, [schema('work', stricter)])).rejects.toThrow(
      /work "old" does not satisfy the new schema/,
    )
    // Fixing the record in the same upload makes the change acceptable; the rest are scanned.
    const fixed = await upload(store, [
      schema('work', stricter),
      work('old', { title: 'x', year: 1 }),
    ])
    expect(fixed.check).toMatchObject({ bump: 'major', scanned: 50, validated: 1 })
    // So does removing it.
    const store2 = await loaded()
    const removed = await upload(store2, [schema('work', stricter), rem('work', 'old')])
    expect(removed.check.scanned).toBe(50)
    // Only that type is scanned.
    expect(removed.check.schemasChanged).toEqual(['work'])
  })

  it('refuses to remove a schema while the type has records', async () => {
    const store = await loaded()
    await expect(upload(store, [rem('$schema', 'other')])).rejects.toThrow(
      /"other" still has records/,
    )
    await expect(upload(store, [rem('$schema', 'other'), rec('other', 'p', {})])).rejects.toThrow(
      /schema is removed/,
    )
    const ok = await upload(store, [rem('$schema', 'other'), rem('other', 'o')])
    expect(ok.commit.semver).toBe('v2.0.0')
    // Removing a schema that is not there changes nothing.
    expect((await upload(store, [rem('$schema', 'never')])).commit.semver).toBe('v2.0.1')
  })
})

describe('checking files', () => {
  it('refuses a file that is not what the upload says, or not well formed', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema)])
    const [f] = await v3.buildFiles([work('a', { title: 'A' })], v3.storeTarget(store))
    const { size: _s, labeled: _l, commits: _c, ...ref } = f!
    await expect(v3.commitUpload(store, 'c', { files: [{ ...ref, entries: 2 }] })).rejects.toThrow(
      /not as the upload describes/,
    )
    await expect(
      v3.commitUpload(store, 'c', { files: [{ ...ref, id: 'f'.repeat(64) }] }),
    ).rejects.toThrow(v3.MissingFileError)
    // A labeled file cannot be uploaded.
    const [labeled] = await v3.buildFiles(
      [rec('work', 'a', { title: 'A' }, 1)],
      v3.storeTarget(store),
      {
        labeled: true,
      },
    )
    const { size: _s2, labeled: _l2, commits: _c2, ...lref } = labeled!
    await expect(v3.commitUpload(store, 'c', { files: [lref] })).rejects.toThrow(/labeled/)
    expect(await v3.headNumber(store, 'c')).toBe(1)
    await v3.commitUpload(store, 'c', { files: [ref] })
  })

  it('checks again against the new head when another commit lands first', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema)])
    const [f] = await v3.buildFiles([work('late', { title: 'no year' })], v3.storeTarget(store))
    const { size: _s, labeled: _l, commits: _c, ...ref } = f!
    // While this upload is being checked, a stricter schema is committed.
    let first = true
    const inner = store.tail.bind(store)
    store.tail = async (key, length) => {
      if (first && key.startsWith('records/')) {
        first = false
        const strict = [schema('work', { ...workSchema, required: ['title', 'year'] })]
        const files = await v3.buildFiles(strict, v3.storeTarget(store))
        await v3.createCommit(store, 'c', {
          files: files.map(({ size: _a, labeled: _b, commits: _d, ...r }) => r),
          bump: 'major',
        })
      }
      return inner(key, length)
    }
    await expect(v3.commitUpload(store, 'c', { files: [ref] })).rejects.toThrow(/work "late"/)
    expect(first).toBe(false)
    expect(await v3.headNumber(store, 'c')).toBe(2)
    expect(jcs((await v3.readCommit(store, 'c', 2))!.commit.semver)).toBe('"v2.0.0"')
  })
})
