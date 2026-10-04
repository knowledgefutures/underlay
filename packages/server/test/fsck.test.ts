import { createHash } from 'node:crypto'

import {
  type FsckCursor,
  fsck,
  fsckStep,
  keys,
  type PublicKeyInfo,
  type Repo,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: { type: 'object' } } }

describe('fsck', () => {
  it('passes a healthy collection and names what breaks', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('docs')
    const base = '/api/collections/org/docs'
    const pdf = 'pdf bytes'
    await h.request(`${base}/files/${sha(pdf)}`, { method: 'PUT', user, body: pdf })
    for (const [i, records] of [
      [
        0,
        Array.from({ length: 2500 }, (_, j) => ({
          id: `d${j}`,
          type: 'Doc',
          data: { title: `T${j}` },
        })),
      ],
      [
        1,
        [
          { id: 'f', type: 'Doc', data: { title: 'F', pdf: { $file: `sha256:${sha(pdf)}` } } },
          { id: 's', type: 'Doc', data: { title: 'S' }, private: true },
        ],
      ],
    ] as const) {
      const open = await h.request(`${base}/push`, {
        method: 'POST',
        user,
        json: i === 0 ? { schemas: { Doc } } : { actor_id: 'pubpub-user-7' },
      })
      const sid = ((await open.json()) as { session_id: string }).session_id
      await h.request(`${base}/push/${sid}/records`, {
        method: 'POST',
        user,
        ndjson: records as unknown[],
      })
      expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
        201,
      )
    }
    const repo = await h.ports.stores.forCollection(c.id)
    const trusted = [h.signer.publicKey]
    // The actor a push names stays with the members: the public log carries null.
    const entry = JSON.parse(await (await repo.blobs.get(`collections/${c.id}/log/2.json`))!.text())
    expect(entry.actorId).toBeNull()
    const [row] = await h.ports.db.select().from(schema.versions).where(eq(schema.versions.seq, 2))
    expect(row!.actorId).toBe('pubpub-user-7')
    const ok = await fsck(repo, { collectionId: c.id, trustedKeys: trusted, fileBytes: true })
    expect(ok).toMatchObject({ ok: true, errors: [], versions: 2, files: 1, log: 'trusted keys' })
    expect(ok.records).toBeGreaterThan(2500)
    expect(ok.leaves).toBeGreaterThan(1)
    // The resumable check agrees, a version per step.
    const stepped = await steps(repo, c.id, trusted)
    expect(stepped).toMatchObject({ ok: true, errors: [], versions: 2, files: 1, steps: 2 })
    expect(stepped.records).toBeGreaterThan(2500)

    // A head.json that names another version fails, though the log verifies.
    const headKey = `collections/${c.id}/head.json`
    const head = await (await repo.blobs.get(headKey))!.text()
    const v1 = JSON.parse(await (await repo.blobs.get(`collections/${c.id}/log/1.json`))!.text())
    await repo.blobs.put(
      headKey,
      JSON.stringify({ ...JSON.parse(head), versionHash: v1.versionHash }),
    )
    expect((await steps(repo, c.id, trusted)).errors).toEqual([
      'head.json does not match the last log entry',
    ])
    await repo.blobs.put(headKey, head)

    // Corrupt a file, drop a body, and sign nothing it trusts.
    await repo.blobs.put(keys.file(sha(pdf)), 'other bytes!')
    const bodies = [...h.bucket.objects.keys()].filter((k) => k.includes('/bodies/'))
    h.bucket.objects.delete(bodies[0]!)
    const bad = await fsck(repo, { collectionId: c.id, trustedKeys: [], fileBytes: true })
    expect(bad.ok).toBe(false)
    const text = bad.errors.join('\n')
    expect(text).toMatch(/log/)
    expect(text).toMatch(/fails its hash or size/)
    expect(text).toMatch(/body of|Missing body/)
    const badSteps = await steps(repo, c.id, trusted)
    expect(badSteps.ok).toBe(false)
    expect(badSteps.errors.join('\n')).toMatch(/fails its hash or size/)
    expect(badSteps.errors.join('\n')).toMatch(/body of|Missing body/)
  })
})

/** fsckStep to the end, one version a step, adding the steps' reports up. */
async function steps(repo: Repo, collectionId: string, trustedKeys: PublicKeyInfo[]) {
  let cursor: FsckCursor | null = null
  const total = { ok: true, errors: [] as string[], versions: 0, records: 0, files: 0, steps: 0 }
  do {
    const r = await fsckStep(repo, {
      collectionId,
      trustedKeys,
      fileBytes: true,
      cursor,
      changeBudget: 1,
    })
    total.ok &&= r.report.ok
    total.errors.push(...r.report.errors)
    total.versions += r.report.versions
    total.records += r.report.records
    total.files += r.report.files
    total.steps++
    cursor = r.cursor
  } while (cursor)
  return total
}

describe('fsck for stewards', () => {
  it('queues a check and serves its report', async () => {
    const { setup } = await import('./kf-app.js')
    const { h, call, user } = await setup()
    await user('u1') // a steward in the fake KF Auth
    const member = await h.member('u1')
    await h.collection('c')
    const open = await h.request('/api/collections/org/c/push', {
      method: 'POST',
      user: member,
      json: { schemas: { Doc } },
    })
    const sid = ((await open.json()) as { session_id: string }).session_id
    await h.request(`/api/collections/org/c/push/${sid}/records`, {
      method: 'POST',
      user: member,
      ndjson: [{ id: 'a', type: 'Doc', data: { title: 'A' } }],
    })
    await h.request(`/api/collections/org/c/push/${sid}/commit`, { method: 'POST', user: member })
    expect((await call('/api/admin/fsck?collection=org/c', { user: 'u1' })).status).toBe(404)
    expect(
      (await call('/api/admin/fsck', { method: 'POST', user: 'u1', json: { collection: 'org/c' } }))
        .status,
    ).toBe(202)
    await h.drain()
    const report = await (await call('/api/admin/fsck?collection=org/c', { user: 'u1' })).json()
    expect(report).toMatchObject({ ok: true, versions: 1, log: 'trusted keys' })
  })
})
