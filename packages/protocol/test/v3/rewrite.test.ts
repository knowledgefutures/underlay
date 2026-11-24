/** Rewriting a collection's history into the protocol's one spelling (rewrite.ts). */
import { describe, expect, it } from 'vitest'

import {
  ed25519Signer,
  jcs,
  memoryStore,
  type MemoryStore,
  sha256Hex,
  v3,
} from '../../src/index.js'
import { dec, putFile, rec } from './helpers.js'

const seed = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
const enc = new TextEncoder()
const H = (n: number) => n.toString(16).padStart(64, '0')

const SCHEMA = { type: 'object' }

async function commitRows(
  store: MemoryStore,
  rows: v3.WriteRow[],
  signer?: v3.Signer,
  base: string | null = null,
) {
  const f = await putFile(store, rows)
  return v3.createCommit(
    store,
    'c',
    { files: [v3.fileRef(f.id, f.content)], bump: 'minor', base },
    { ...(signer ? { signer } : {}), now: () => new Date('2026-11-01T00:00:00Z') },
  )
}

/** A commit's id from its stored bytes, which a reader may no longer parse. */
const rawId = async (store: MemoryStore, n: number) =>
  `ul:ver:${sha256Hex(await (await store.get(v3.commitKey('c', n)))!.bytes())}`

/** Put commit `n` back as a draft wrote it: `ulv3:` ids, signed again, chained to the one before. */
async function legacyChain(store: MemoryStore, signer: v3.Signer, upTo: number) {
  let prev: string | null = null
  for (let n = 1; n <= upTo; n++) {
    const c = (await v3.readCommit(store, 'c', n))!.commit
    const legacy = {
      ...c,
      previous: prev === null ? null : `ulv3:${prev}`,
      changes: c.changes.map((ch) => ({
        ...ch,
        base: ch.base === null ? null : `ulv3:${ch.base}`,
      })),
      keyId: null,
      sig: null,
    }
    const signed = await v3.signObject(legacy as unknown as v3.Commit, signer)
    const bytes = enc.encode(jcs(signed))
    await store.put(v3.commitKey('c', n), bytes)
    prev = sha256Hex(bytes)
  }
}

describe('rewrite', () => {
  it('converts $file references and leaves other data alone', () => {
    const data = {
      a: { $file: `sha256:${H(1)}`, fileName: 'x.pdf' },
      b: [{ $file: `sha256:${H(2)}` }, { $file: 'not a hash' }],
      c: { $link: `ul:rec:${H(3)}`, inner: { $file: `sha256:${H(4)}` } },
      d: 1,
    }
    const { data: out, count } = v3.convertFileRefs(data)
    expect(count).toBe(2)
    expect(out).toEqual({
      a: { $asset: `ul:asset:${H(1)}`, fileName: 'x.pdf' },
      b: [{ $asset: `ul:asset:${H(2)}` }, { $file: 'not a hash' }],
      c: data.c,
      d: 1,
    })
    expect(v3.convertFileRefs(out).count).toBe(0)
    expect(v3.convertFileRefs({ d: 1 }).data).toEqual({ d: 1 })
  })

  it('rewrites ulv3: ids in a signed log, and a second run changes nothing', async () => {
    const store = memoryStore()
    const signer = await ed25519Signer(seed)
    await commitRows(store, [rec('$schema', 'T', SCHEMA), rec('T', 'a', { n: 1 })], signer)
    const c1 = (await v3.readCommit(store, 'c', 1))!
    await commitRows(store, [rec('T', 'b', { n: 2 })], signer, v3.versionHex(c1.id))
    await commitRows(store, [rec('T', 'c', { n: 3 })], signer)
    await legacyChain(store, signer, 3)
    const before = [1, 2, 3].map((n) => rawId(store, n))
    const beforeIds = await Promise.all(before)

    const dry = await v3.rewriteCollection(store, 'c', { signer, dryRun: true })
    expect(dry.commits.filter((c) => c.before !== c.after).map((c) => c.number)).toEqual([2, 3])
    expect(await rawId(store, 2)).toBe(beforeIds[1])

    const plan = await v3.rewriteCollection(store, 'c', { signer })
    expect(plan.records).toBe(0)
    expect(plan.layout).toBe(null)
    for (let n = 1; n <= 3; n++) {
      const text = dec.decode((await v3.readCommit(store, 'c', n))!.bytes)
      expect(text).not.toContain('ulv3:')
    }
    await v3.verifyLog(store, 'c', { serverKeys: [signer.publicKey], files: true })
    const c2 = (await v3.readCommit(store, 'c', 2))!
    expect(c2.commit.changes[0]!.base).toBe(v3.versionHex((await v3.readCommit(store, 'c', 1))!.id))
    expect(plan.commits[1]).toEqual({
      number: 2,
      before: v3.versionHex(beforeIds[1]),
      after: v3.versionHex(c2.id),
    })

    const again = await v3.rewriteCollection(store, 'c', { signer })
    expect(again.commits).toEqual(plan.commits)
    expect((await v3.readCommit(store, 'c', 2))!.id).toBe(c2.id)
  })

  it('converts $file records behind a layout, and the versions read the same otherwise', async () => {
    const store = memoryStore()
    const signer = await ed25519Signer(seed)
    const ref = (n: number) => ({ $file: `sha256:${H(n)}`, fileName: `${n}.png` })
    const asset = (n: number) => rec('$asset', H(n), { size: 1, mediaType: null })
    await commitRows(
      store,
      [
        asset(1),
        rec('$schema', 'T', SCHEMA),
        rec('T', 'a', { cover: ref(1) }),
        rec('T', 'b', { n: 1 }),
      ],
      signer,
    )
    await commitRows(store, [asset(2), rec('T', 'c', { cover: ref(2) })], signer)
    await v3.rebuild(store, 'c', { plan: v3.planAll })
    const layoutBefore = await v3.findLayout(store, 'c')
    expect(layoutBefore?.through).toBe(2)
    await commitRows(store, [rec('T', 'a', { cover: ref(2), again: true })], signer)
    await legacyChain(store, signer, 3)

    const plan = await v3.rewriteCollection(store, 'c', { signer })
    expect(plan.records).toBe(3)
    expect(plan.layout).toBe(layoutBefore!.number + 1)
    await v3.verifyLog(store, 'c', { serverKeys: [signer.publicKey], filesFrom: 3, files: true })

    const layout = (await v3.findLayout(store, 'c'))!
    expect(layout.number).toBe(plan.layout)
    expect(layout.files.every((f) => !f.labeled)).toBe(true)
    for (const f of layout.files) await v3.verifyFile(store, v3.recordKey(f.id), { id: f.id })

    const read = async (version: number, id: string) => {
      const view = await v3.openView(store, 'c', { version })
      const r = await v3.getRecord(store, view, 'T', id)
      return r?.line ? (JSON.parse(dec.decode(r.line)) as { data: unknown }).data : null
    }
    expect(await read(1, 'a')).toEqual({ cover: { $asset: `ul:asset:${H(1)}`, fileName: '1.png' } })
    expect(await read(2, 'c')).toEqual({ cover: { $asset: `ul:asset:${H(2)}`, fileName: '2.png' } })
    expect(await read(3, 'a')).toEqual({
      cover: { $asset: `ul:asset:${H(2)}`, fileName: '2.png' },
      again: true,
    })
    expect(await read(3, 'b')).toEqual({ n: 1 })

    // Run again: nothing left to change.
    const again = await v3.rewriteCollection(store, 'c', { signer })
    expect(again.records).toBe(0)
    expect(again.files).toBe(0)
    expect((await v3.findLayout(store, 'c'))!.number).toBe(layout.number)
  })

  it('finishes a rewrite that stopped part way when run again', async () => {
    const build = async () => {
      const store = memoryStore()
      const signer = await ed25519Signer(seed)
      for (let n = 1; n <= 4; n++)
        await commitRows(store, [rec('$schema', 'T', SCHEMA), rec('T', `${n}`, { n })], signer)
      await legacyChain(store, signer, 4)
      return { store, signer }
    }
    const whole = await build()
    const want = await v3.rewriteCollection(whole.store, 'c', { signer: whole.signer })

    const { store, signer } = await build()
    const put = store.put.bind(store)
    let fail = true
    store.put = async (key, body, opts) => {
      if (fail && key === v3.commitKey('c', 3)) {
        fail = false
        throw new Error('stopped')
      }
      return put(key, body, opts)
    }
    await expect(v3.rewriteCollection(store, 'c', { signer })).rejects.toThrow('stopped')
    // Commit 2 is new, 3 and 4 old: the log does not verify until the rewrite is finished.
    await expect(v3.verifyLog(store, 'c')).rejects.toThrow()
    const done = await v3.rewriteCollection(store, 'c', { signer })
    expect(done.commits).toEqual(want.commits)
    await v3.verifyLog(store, 'c', { serverKeys: [signer.publicKey] })
  })

  it('converts a schema that names $file, as PubPub schemas do, with its records', async () => {
    const store = memoryStore()
    const signer = await ed25519Signer(seed)
    const pubpub = {
      type: 'object',
      properties: {
        cover: {
          type: 'object',
          properties: {
            $file: { type: 'string', pattern: '^sha256:' },
            fileName: { type: 'string' },
          },
          required: ['$file'],
        },
      },
    }
    await commitRows(
      store,
      [
        rec('$asset', H(1), { size: 1, mediaType: null }),
        rec('$schema', 'T', pubpub),
        rec('T', 'a', { cover: { $file: `sha256:${H(1)}`, fileName: 'a.png' } }),
      ],
      signer,
    )
    await commitRows(store, [rec('T', 'b', { cover: { $file: `sha256:${H(1)}` } })], signer)
    const plan = await v3.rewriteCollection(store, 'c', { signer })
    expect(plan.records).toBe(2)
    expect(plan.schemas).toHaveLength(1)
    const view = await v3.openView(store, 'c')
    const schema = await v3.getRecord(store, view, '$schema', 'T')
    const body = (JSON.parse(dec.decode(schema!.line!)) as { data: unknown }).data
    expect(body).toEqual({
      type: 'object',
      properties: {
        cover: {
          type: 'object',
          properties: {
            $asset: { type: 'string', pattern: '^ul:asset:' },
            fileName: { type: 'string' },
          },
          required: ['$asset'],
        },
      },
    })
    expect(plan.schemas[0]!.after).toBe(sha256Hex(jcs(body)))
    expect(plan.schemas[0]!.before).toBe(sha256Hex(jcs(pubpub)))
    await v3.verifyLog(store, 'c', { serverKeys: [signer.publicKey], files: true })
  })

  it('converts a schema that names $file in a collection with no assets', async () => {
    const store = memoryStore()
    const signer = await ed25519Signer(seed)
    const avatar = {
      type: 'object',
      properties: { $file: { type: 'string' } },
      required: ['$file'],
    }
    const schema = { type: 'object', properties: { avatar } }
    await commitRows(store, [rec('$schema', 'T', schema), rec('T', 'a', { n: 1 })], signer)
    await commitRows(store, [rec('T', 'b', { n: 2 })], signer)
    const plan = await v3.rewriteCollection(store, 'c', { signer })
    expect(plan.records).toBe(0)
    expect(plan.schemas).toHaveLength(1)
    const view = await v3.openView(store, 'c')
    const row = await v3.getRecord(store, view, '$schema', 'T')
    expect(dec.decode(row!.line!)).toContain('"required":["$asset"]')
    await v3.verifyLog(store, 'c', { serverKeys: [signer.publicKey], files: true })
    // A collection with neither assets nor such a schema is not read at all.
    const plain = memoryStore()
    await commitRows(plain, [rec('$schema', 'T', SCHEMA), rec('T', 'a', { n: 1 })], signer)
    expect((await v3.rewriteCollection(plain, 'c', { signer })).files).toBe(0)
  })

  it('checks records again only where renaming $file to $asset could change the verdict', () => {
    const loose = { type: 'object', properties: { cover: { type: 'object' } }, required: ['cover'] }
    expect(v3.renameMatters(loose)).toBe(false)
    expect(v3.renameMatters({ ...loose, enum: [{ a: 1 }] })).toBe(false)
    expect(v3.renameMatters({ properties: { c: { properties: { $file: {} } } } })).toBe(true)
    expect(v3.renameMatters({ properties: { c: { additionalProperties: false } } })).toBe(true)
    expect(
      v3.renameMatters({ properties: { c: { additionalProperties: { type: 'string' } } } }),
    ).toBe(true)
    expect(v3.renameMatters({ properties: { c: { additionalProperties: true } } })).toBe(false)
    expect(v3.renameMatters({ items: [{ patternProperties: { '^x': {} } }] })).toBe(true)
    expect(v3.renameMatters({ properties: { c: { propertyNames: { maxLength: 9 } } } })).toBe(true)
  })

  it('refuses a conversion its schema would reject, and writes nothing', async () => {
    const store = memoryStore()
    const signer = await ed25519Signer(seed)
    // Takes members beginning `$f` only: `$file`, not `$asset`.
    const strict = {
      type: 'object',
      properties: {
        cover: { type: 'object', patternProperties: { '^\\$f': {} }, additionalProperties: false },
      },
    }
    await commitRows(
      store,
      [
        rec('$asset', H(1), { size: 1, mediaType: null }),
        rec('$schema', 'T', strict),
        rec('T', 'a', { cover: { $file: `sha256:${H(1)}` } }),
      ],
      signer,
    )
    const before = (await v3.readCommit(store, 'c', 1))!.id
    await expect(v3.rewriteCollection(store, 'c', { signer })).rejects.toThrow(/fails its schema/)
    expect((await v3.readCommit(store, 'c', 1))!.id).toBe(before)
    expect(await v3.readPlan(store, 'c')).toBe(null)
  })
})
