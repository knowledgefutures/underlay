/**
 * The rewrite into the protocol's one spelling (v3/rewrite.ts): a collection whose commits
 * were written with `ulv3:` ids, as production's were until 2026-11-22, is rewritten through
 * the stewards' route; D1 follows, and its old ids still resolve.
 */
import { jcs, sha256Hex, v3 } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, type Harness } from './harness.js'
import { setup } from './kf-app.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const json = async (r: Response) => (await r.json()) as Record<string, any>
const enc = new TextEncoder()

async function push(h: Harness, user: string, base: string, body: object, records: object[]) {
  const opened = await h.request(`${base}/push`, { method: 'POST', user, json: body })
  const sid = (await json(opened)).session_id as string
  await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  await h.drain()
  return json(res)
}

/** Put the log back as the drafts wrote it: `ulv3:` ids in commits and in D1. */
async function legacify(h: Harness, cid: string, head: number) {
  const store = h.ports.stores.v3
  let prev: string | null = null
  for (let n = 1; n <= head; n++) {
    const c = (await v3.readCommit(store, cid, n))!.commit
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
    const signed = await v3.signObject(legacy as unknown as v3.Commit, h.signer)
    const bytes = enc.encode(jcs(signed))
    await store.put(v3.commitKey(cid, n), bytes)
    prev = sha256Hex(bytes)
    await h.ports.db
      .update(schema.versions)
      .set({ hash: `ulv3:${prev}` })
      .where(and(eq(schema.versions.collectionId, cid), eq(schema.versions.seq, n)))
  }
  return prev!
}

describe.skipIf(!onV3)('v3 rewrite', () => {
  it('rewrites a log written with ulv3: ids, and old ids still resolve', async () => {
    const { h, call } = await setup()
    const user = await h.member()
    const c = await h.collection('lib', { recordLayout: 'v3' })
    await h.ports.db
      .update(schema.collections)
      .set({ public: true })
      .where(eq(schema.collections.id, c.id))
    const base = '/api/collections/org/lib'
    for (let i = 1; i <= 3; i++) {
      await push(h, user, base, { schemas: { Author } }, [
        { id: `a${i}`, type: 'Author', data: { name: `Author ${i}` } },
      ])
    }
    const oldHead = await legacify(h, c.id, 3)

    const dry = await json(
      await call('/api/admin/v3/rewrite', {
        method: 'POST',
        user: 'u1',
        json: { collection: 'org/lib', dryRun: true },
      }),
    )
    expect(dry).toMatchObject({ rewritten: 2, records: 0, dryRun: true })
    const stored = await h.ports.stores.v3.get(v3.commitKey(c.id, 3))
    expect(sha256Hex(await stored!.bytes())).toBe(oldHead)

    const done = await json(
      await call('/api/admin/v3/rewrite', {
        method: 'POST',
        user: 'u1',
        json: { collection: 'org/lib' },
      }),
    )
    expect(done).toMatchObject({ rewritten: 2, records: 0 })

    const head = (await v3.findHead(h.ports.stores.v3, c.id))!
    const rows = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    const last = rows.find((r) => r.seq === 3)!
    expect(last.hash).toBe(head.id)
    expect(last.formerHash).toBe(`ul:ver:${oldHead}`)
    expect(rows.find((r) => r.seq === 1)!.formerHash).toBeNull()

    // The old id finds the version; the new one does too.
    const byOld = await h.request(`${base}/versions/ul:ver:${oldHead}`)
    expect(byOld.status).toBe(200)
    expect((await json(byOld)).semver).toBe(last.semver)
    expect((await h.request(`${base}/versions/${head.id}`)).status).toBe(200)

    // The description says whether it is public, and which key signs it.
    const d = (await v3.readDescription(h.ports.stores.v3, c.id))!
    expect(d.public).toBe(true)
    expect(d.keys).toEqual([
      { keyId: h.signer.keyId, alg: 'Ed25519', publicKey: h.signer.publicKey.publicKey },
    ])
    await v3.verifyLog(h.ports.stores.v3, c.id, { serverKeys: [h.signer.publicKey] })

    // A push after it lands on the rewritten head.
    const v4 = await push(h, user, base, { schemas: { Author } }, [
      { id: 'a4', type: 'Author', data: { name: 'Author 4' } },
    ])
    expect(v4.semver).toBe('v1.3.0')
    const after = (await v3.readCommit(h.ports.stores.v3, c.id, 4))!
    expect(after.commit.previous).toBe(v3.versionHex(head.id))

    // Run again: nothing to do.
    const again = await json(
      await call('/api/admin/v3/rewrite', {
        method: 'POST',
        user: 'u1',
        json: { collection: 'org/lib' },
      }),
    )
    expect(again).toMatchObject({ rewritten: 2 })
    expect((await v3.findHead(h.ports.stores.v3, c.id))!.id).toBe(after.id)

    const list = await json(await call('/api/admin/v3/rewrite', { user: 'u1' }))
    expect(list.outcomes[0]).toMatchObject({ collection: 'org/lib', collectionId: c.id })
  })

  it('is for stewards only', async () => {
    const { h, call } = await setup()
    const user = await h.member('u2')
    await h.collection('lib', { recordLayout: 'v3' })
    const res = await call('/api/admin/v3/rewrite', {
      method: 'POST',
      user,
      json: { collection: 'org/lib' },
    })
    expect(res.status).toBe(403)
  })
})
