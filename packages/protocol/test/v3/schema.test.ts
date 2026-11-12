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
  // The bytes arrive in an upload session; the commit installs them once they are checked.
  const session = v3.newSession()
  const files = await v3.buildFiles(sorted, v3.uploadTarget(store, session), opts)
  const refs = files.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ref)
  return v3.commitUpload(store, 'c', { files: refs }, { ...opts, session })
}

/** Build rows into an upload session without committing: the session and what a commit would name. */
async function staged(store: MemoryStore, rows: v3.WriteRow[], opts: v3.BuildOptions = {}) {
  const session = v3.newSession()
  const files = await v3.buildFiles(rows, v3.uploadTarget(store, session), opts)
  return { session, refs: files.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ref) }
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

  it('validates a type whose first row in the upload is a removal', async () => {
    const store = memoryStore()
    await upload(store, [
      schema('work', workSchema),
      work('a', { title: 'A' }),
      work('m', { title: 'M' }),
    ])
    const r = await upload(store, [
      rem('work', 'a'),
      work('b', { title: 'B' }),
      work('c', { title: 'C' }),
    ])
    expect(r.check).toMatchObject({ bump: 'minor', validated: 2 })
    await expect(upload(store, [rem('work', 'b'), work('d', { year: 1 })])).rejects.toThrow(
      /work "d"/,
    )
    // Only removals of a type with no schema: nothing to validate, nothing refused.
    await upload(store, [rem('ghost', 'x')])
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

  it('fetches the block holding the schemas once, however many types an upload has', async () => {
    const store = memoryStore()
    const types = ['t1', 't2', 't3', 't4', 't5']
    const rows = types.map((t) => schema(t, { type: 'object' }))
    // Enough that the first record block does not come with the footer's 64 KiB.
    let pad = 'x'
    for (let i = 0; i < 80; i++) {
      pad = sha256Hex(pad)
      rows.push(
        rec('t1', `pad${i}`, {
          text: Array.from({ length: 60 }, (_, j) => sha256Hex(pad + j)).join(''),
        }),
      )
    }
    await upload(store, rows)
    const gets: string[] = []
    const get = store.get.bind(store)
    store.get = (key, range) => {
      if (key.startsWith('records/')) gets.push(`${key} ${range?.offset}`)
      return get(key, range)
    }
    const r = await upload(
      store,
      types.map((t) => rec(t, 'new', {})),
      { verify: false },
    )
    expect(r.check.validated).toBe(5)
    // One read of the stored file's first record block, for five schemas.
    expect(gets.filter((g) => g.endsWith(' 0'))).toHaveLength(1)
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
    const { session, refs } = await staged(store, [work('a', { title: 'A' })])
    const ref = refs[0]!
    await expect(
      v3.commitUpload(store, 'c', { files: [{ ...ref, entries: 2 }] }, { session }),
    ).rejects.toThrow(/not as the upload describes/)
    // A labeled file cannot be uploaded.
    const labeled = await staged(store, [rec('work', 'a', { title: 'A' }, 1)], { labeled: true })
    await expect(
      v3.commitUpload(store, 'c', { files: labeled.refs }, { session: labeled.session }),
    ).rejects.toThrow(/labeled/)
    // Not even from a builder whose files are otherwise taken as well formed.
    await expect(
      v3.commitUpload(
        store,
        'c',
        { files: labeled.refs },
        { session: labeled.session, verify: false },
      ),
    ).rejects.toThrow(/labeled/)
    expect(await v3.headNumber(store, 'c')).toBe(1)
    await v3.commitUpload(store, 'c', { files: [ref] }, { session })
    expect(await v3.headNumber(store, 'c')).toBe(2)
  })

  it('lets a commit name a file only if its bytes came with the upload', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema), work('a', { title: 'A' })])
    // The first commit's file is stored. Knowing its id is not enough to name it again.
    const stored = v3.commitFiles((await v3.readCommit(store, 'c', 1))!.commit)[0]!
    expect(await store.head(v3.recordKey(stored.id))).not.toBe(null)
    await expect(
      v3.commitUpload(store, 'other', { files: [stored] }, { session: v3.newSession() }),
    ).rejects.toThrow(/did not come with this upload/)
    expect(await v3.headNumber(store, 'other')).toBe(0)
    // Nor is a file in someone else's session.
    const theirs = await staged(store, [work('b', { title: 'B' })])
    await expect(
      v3.commitUpload(store, 'c', { files: theirs.refs }, { session: v3.newSession() }),
    ).rejects.toThrow(/did not come with this upload/)

    // Sending the same bytes again is fine: the upload is checked, the stored file is left
    // as it is, and the session's copy is gone afterwards.
    const before = (await (await store.get(v3.recordKey(stored.id)))!.bytes()).slice()
    const again = await staged(
      store,
      [schema('work', workSchema), work('a', { title: 'A' })].sort(v3.compareKey),
      { level: 1 },
    )
    expect(again.refs[0]!.id).toBe(stored.id)
    const made = await v3.commitUpload(store, 'c2', { files: again.refs }, again)
    expect(made.commit.number).toBe(1)
    expect(await (await store.get(v3.recordKey(stored.id)))!.bytes()).toEqual(before)
    expect(await store.head(v3.uploadKey(again.session, stored.id))).toBe(null)
  })

  it('installs an uploaded file among the stored files only once it is checked', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema)])
    const bad = await staged(store, [work('x', { year: 1 })])
    await expect(v3.commitUpload(store, 'c', { files: bad.refs }, bad)).rejects.toThrow(/work "x"/)
    expect(await store.head(v3.recordKey(bad.refs[0]!.id))).toBe(null)
    const good = await staged(store, [work('x', { title: 'X' })])
    await v3.commitUpload(store, 'c', { files: good.refs }, good)
    expect(await store.head(v3.recordKey(good.refs[0]!.id))).not.toBe(null)
    expect(await store.head(v3.uploadKey(good.session, good.refs[0]!.id))).toBe(null)
  })

  it('does not check an upload twice when the commit that beat it changed no schema', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema)])
    const late = await staged(store, [work('late', { title: 'Late' })])
    // While this upload is being checked, another upload of records is committed.
    let first = true
    const reads: string[] = []
    const inner = store.tail.bind(store)
    store.tail = async (key, length) => {
      if (key.startsWith(`uploads/${late.session}/`)) reads.push(key)
      if (first && key.startsWith(`uploads/${late.session}/`)) {
        first = false
        await upload(store, [work('early', { title: 'Early' })])
      }
      return inner(key, length)
    }
    const made = await v3.commitUpload(store, 'c', { files: late.refs }, late)
    expect(made.commit.number).toBe(3)
    expect(made.commit.semver).toBe('v1.2.0')
    expect(made.check.validated).toBe(1)
    const once = [...reads]
    // The same upload with nothing racing it reads its file as many times.
    const calm = await staged(store, [work('calm', { title: 'Calm' })])
    reads.length = 0
    store.tail = async (key, length) => {
      if (key.startsWith(`uploads/${calm.session}/`)) reads.push(key)
      return inner(key, length)
    }
    await v3.commitUpload(store, 'c', { files: calm.refs }, calm)
    expect(once).toHaveLength(reads.length)
  })

  it('checks again against the new head when another commit lands first', async () => {
    const store = memoryStore()
    await upload(store, [schema('work', workSchema)])
    const late = await staged(store, [work('late', { title: 'no year' })])
    // While this upload is being checked, a stricter schema is committed.
    let first = true
    const inner = store.tail.bind(store)
    store.tail = async (key, length) => {
      if (first && key.startsWith(`uploads/${late.session}/`)) {
        first = false
        await upload(store, [schema('work', { ...workSchema, required: ['title', 'year'] })])
      }
      return inner(key, length)
    }
    await expect(v3.commitUpload(store, 'c', { files: late.refs }, late)).rejects.toThrow(
      /work "late"/,
    )
    expect(first).toBe(false)
    expect(await v3.headNumber(store, 'c')).toBe(2)
    expect(jcs((await v3.readCommit(store, 'c', 2))!.commit.semver)).toBe('"v2.0.0"')
  })
})

describe('a schema scan in key-range units', () => {
  it('finds what the whole scan finds, unit by unit, skipping what the upload replaces', async () => {
    const store = memoryStore()
    await v3.createCollection(store, 's')
    const Work = { type: 'object', properties: { n: { type: 'integer' } } }
    const rows = [
      v3.rowFromRecord('Work', v3.SCHEMA_TYPE, Work),
      ...Array.from({ length: 50 }, (_, i) =>
        v3.rowFromRecord(`w${String(i).padStart(3, '0')}`, 'Work', { n: i }),
      ),
    ].sort(v3.compareKey)
    const files = await v3.buildFiles(rows, v3.storeTarget(store), { cutBytes: 600 })
    await v3.createCommit(store, 's', {
      files: files.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ref),
      bump: 'minor',
    })
    const view = await v3.openView(store, 's')
    // An upload that replaces w045 (it now fits), against a schema that refuses n > 30.
    const strict = { type: 'object', properties: { n: { type: 'integer', maximum: 30 } } }
    const session = v3.newSession()
    const up = await v3.buildFiles(
      [v3.rowFromRecord('w045', 'Work', { n: 1 })],
      v3.uploadTarget(store, session),
    )
    const upload = { files: up, locate: (id: string) => v3.uploadKey(session, id) }
    const whole = await v3.scanUnderSchema(
      store,
      view,
      upload,
      'Work',
      strict,
      {},
      {
        maxProblems: 100,
      },
    )
    expect(whole.scanned).toBe(49)
    expect(whole.problems).toHaveLength(18)
    let scanned = 0
    let problems = 0
    const cuts = ['w010', 'w025', 'w045', 'w046']
    for (let i = 0; i <= cuts.length; i++) {
      const range = {
        ...(i > 0 ? { from: cuts[i - 1]! } : {}),
        ...(i < cuts.length ? { to: cuts[i]! } : {}),
      }
      const r = await v3.scanUnderSchema(store, view, upload, 'Work', strict, range, {
        maxProblems: 100,
      })
      scanned += r.scanned
      problems += r.problems.length
    }
    expect(scanned).toBe(49)
    expect(problems).toBe(18)
  })
})
