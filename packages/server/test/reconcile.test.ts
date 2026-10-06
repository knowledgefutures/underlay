import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { reconcileConfig, reconcileDue } from '../src/billing/reconcile.js'
import * as schema from '../src/db/schema.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)
const perSweep = reconcileConfig.perSweep

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: { type: 'object' } } }

async function push(h: Harness, user: string, base: string, open: object, records: object[]) {
  const sid = (
    (await (await h.request(`${base}/push`, { method: 'POST', user, json: open })).json()) as {
      session_id: string
    }
  ).session_id
  await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(201)
  await h.drain()
}

async function reconcile(h: Harness, collectionId: string, full = false) {
  await h.ports.jobs.enqueue({ type: 'reconcile.collection', collectionId, full })
  await h.drain()
  const [c] = await h.ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  return c!
}

describe('reconcile', () => {
  it('finds nothing to correct after normal commits, and corrects what was broken', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('docs')
    const base = '/api/collections/org/docs'
    const pdf = 'pdf bytes'
    await h.request(`${base}/files/${sha(pdf)}`, { method: 'PUT', user, body: pdf })
    await push(h, user, base, { schemas: { Doc } }, [
      { id: 'a', type: 'Doc', data: { title: 'A', pdf: { $file: `sha256:${sha(pdf)}` } } },
      { id: 'b', type: 'Doc', data: { title: 'B' } },
    ])
    await push(h, user, base, {}, [{ id: 'c', type: 'Doc', data: { title: 'C' } }])
    const before = await reconcile(h, c.id)
    expect(before.reconcileReport).toBeNull()
    expect(before.reconciledAt).not.toBeNull()
    expect(before.refEvents).toBeGreaterThan(0)
    const versions = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    expect(versions.every((v) => v.refEvents !== null && v.reconcileReport === null)).toBe(true)

    // Break every counter it keeps, and one row that predates per-version counts.
    const v1 = versions.find((v) => v.seq === 1)!
    const v2 = versions.find((v) => v.seq === 2)!
    await h.ports.db
      .update(schema.collections)
      .set({ refEvents: 999, refBytes: 1, publicFilesRoot: null })
      .where(eq(schema.collections.id, c.id))
    await h.ports.db
      .update(schema.versions)
      .set({ recordCount: 0, typeCounts: {} })
      .where(eq(schema.versions.id, v1.id))
    await h.ports.db
      .update(schema.versions)
      .set({ refEvents: null, refBytes: null })
      .where(eq(schema.versions.id, v2.id))
    await h.ports.db.delete(schema.schemaUsage).where(eq(schema.schemaUsage.collectionId, c.id))

    // A scheduled run checks only versions it hasn't: v1's row isn't looked at again.
    const scheduled = await reconcile(h, c.id)
    const seen = (scheduled.reconcileReport ?? []).map(
      (d) => `${d.field}${d.seq ? `@${d.seq}` : ''}`,
    )
    expect(seen.sort()).toEqual(['publicFilesRoot', 'refBytes', 'refEvents', 'schemaUsage'].sort())
    await h.ports.db
      .update(schema.collections)
      .set({ refEvents: 999, refBytes: 1, publicFilesRoot: null })
      .where(eq(schema.collections.id, c.id))
    await h.ports.db.delete(schema.schemaUsage).where(eq(schema.schemaUsage.collectionId, c.id))

    // A steward's run checks every version.
    const after = await reconcile(h, c.id, true)
    const fields = (after.reconcileReport ?? []).map((d) => `${d.field}${d.seq ? `@${d.seq}` : ''}`)
    expect(fields.sort()).toEqual(
      [
        'publicFilesRoot',
        'recordCount@1',
        'refBytes',
        'refEvents',
        'schemaUsage',
        'typeCounts@1',
      ].sort(),
    )
    expect(after).toMatchObject({
      refEvents: before.refEvents,
      refBytes: before.refBytes,
      publicFilesRoot: before.publicFilesRoot,
    })
    const [fixed] = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, v1.id))
    expect(fixed).toMatchObject({ recordCount: v1.recordCount, typeCounts: v1.typeCounts })
    const [filled] = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, v2.id))
    expect(filled).toMatchObject({
      refEvents: v2.refEvents,
      refBytes: v2.refBytes,
      reconcileReport: null,
    })
    expect(
      await h.ports.db
        .select()
        .from(schema.schemaUsage)
        .where(eq(schema.schemaUsage.collectionId, c.id)),
    ).toHaveLength(1)
  })

  it('starts the runs that are due from the sweep', async () => {
    const h = await harness()
    await h.member()
    const a = await h.collection('a')
    await h.collection('b')
    await h.collection('c')
    reconcileConfig.perSweep = 2
    expect(await reconcileDue(h.ports)).toBe(2)
    await h.drain()
    // The two done aren't due again for a week; the third is.
    expect(await reconcileDue(h.ports)).toBe(1)
    await h.drain()
    expect(await reconcileDue(h.ports)).toBe(0)
    const [row] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, a.id))
    expect(row!.reconciledAt).not.toBeNull()
    reconcileConfig.perSweep = perSweep
  })

  it('runs as a chain of small jobs, and rebuilds files from its last checkpoint', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('docs')
    const base = '/api/collections/org/docs'
    await h.ports.db.update(schema.collections).set({ public: true })
    for (let i = 0; i < 4; i++) {
      const pdf = `pdf ${i}`
      await h.request(`${base}/files/${sha(pdf)}`, { method: 'PUT', user, body: pdf })
      await push(h, user, base, i === 0 ? { schemas: { Doc } } : {}, [
        // Each version replaces the last one's file: the cumulative tree keeps them all.
        { id: 'a', type: 'Doc', data: { title: `A${i}`, pdf: { $file: `sha256:${sha(pdf)}` } } },
      ])
    }
    reconcileConfig.versionsPerJob = 1
    try {
      const first = await reconcile(h, c.id)
      expect(first.reconcileReport).toBeNull()
      expect(first).toMatchObject({ reconciledSeq: 4, reconcileState: null })
      expect(first.reconciledFilesRoot).toBe(first.publicFilesRoot)

      // One more version; the next run starts its files tree from seq 4.
      await h.request(`${base}/files/${sha('pdf 4')}`, { method: 'PUT', user, body: 'pdf 4' })
      await push(h, user, base, {}, [
        { id: 'a', type: 'Doc', data: { title: 'A4', pdf: { $file: `sha256:${sha('pdf 4')}` } } },
      ])
      const good = (
        await h.ports.db.select().from(schema.collections).where(eq(schema.collections.id, c.id))
      )[0]!.publicFilesRoot
      await h.ports.db
        .update(schema.collections)
        .set({ publicFilesRoot: null })
        .where(eq(schema.collections.id, c.id))
      const second = await reconcile(h, c.id)
      expect(second.reconcileReport?.map((d) => d.field)).toEqual(['publicFilesRoot'])
      expect(second).toMatchObject({ reconciledSeq: 5, publicFilesRoot: good })
      for (let i = 0; i < 5; i++) {
        const res = await h.request(`${base}/files/${sha(`pdf ${i}`)}`)
        expect(res.status).toBe(302)
      }
    } finally {
      reconcileConfig.versionsPerJob = 100
    }
  })
})
