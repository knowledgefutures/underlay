import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup } from './harness.js'
import { setup } from './kf-app.js'

afterAll(cleanup)

/** Two public collections with a version each, one private one, and another org's. */
async function org() {
  const s = await setup()
  const { h, db } = s
  await h.member('u1')
  const trees = await h.collection('trees')
  const dogs = await h.collection('dogs')
  const notes = await h.collection('notes')
  await db
    .update(schema.collections)
    .set({
      public: true,
      name: 'Street Trees',
      summary: { description: 'Every street tree', tags: ['Environment'], license: 'CC0-1.0' },
    })
    .where(eq(schema.collections.id, trees.id))
  await db
    .update(schema.collections)
    .set({ public: true, name: 'Dog Licenses' })
    .where(eq(schema.collections.id, dogs.id))
  const version = (collectionId: string, seq: number, at: number, records: number) => ({
    collectionId,
    seq,
    semver: `1.${seq - 1}.0`,
    major: 1,
    minor: seq - 1,
    patch: 0,
    hash: `h-${collectionId}-${seq}`,
    message: `Push ${records} records`,
    recordCount: records + 1,
    publicRecordCount: records,
    fileCount: 0,
    totalBytes: 1000,
    publicTotalBytes: 900,
    typeCounts: { Tree: records, Secret: 1 },
    publicTypeCounts: { Tree: records },
    createdAt: new Date(at),
  })
  const rows = await db
    .insert(schema.versions)
    .values([
      version(trees.id, 1, 1_000, 10),
      version(trees.id, 2, 3_000, 12),
      version(dogs.id, 1, 2_000, 5),
      version(notes.id, 1, 4_000, 7),
    ])
    .returning()
  await db
    .update(schema.collections)
    .set({ headVersionId: rows[1]!.id })
    .where(eq(schema.collections.id, trees.id))
  await db.insert(schema.organization).values({ id: 'org2', name: 'Other', slug: 'other' })
  const [theirs] = await db
    .insert(schema.collections)
    .values({ organizationId: 'org2', slug: 'x', name: 'x', privateSalt: 's' })
    .returning()
  return { ...s, trees, dogs, notes, theirs: theirs! }
}

describe('org page', () => {
  it('saves the page fields, and refuses bad ones', async () => {
    const { call } = await org()
    const patch = (json: unknown) =>
      call('/api/accounts/org', { method: 'PATCH', user: 'u1', json })

    expect(
      (
        await patch({
          tagline: '  Public data, structured.  ',
          location: 'New York, NY',
          coverColor: '#22394F',
          provenanceNote: 'Imported by Knowledge Futures.',
          bio: '## About\n\nMarkdown.',
          website: 'https://example.org',
        })
      ).status,
    ).toBe(200)
    expect(await (await call('/api/accounts/org')).json()).toMatchObject({
      tagline: 'Public data, structured.',
      location: 'New York, NY',
      coverColor: '#22394f',
      provenanceNote: 'Imported by Knowledge Futures.',
      bio: '## About\n\nMarkdown.',
      website: 'https://example.org',
      pinned: [],
    })

    expect((await patch({ tagline: 'x'.repeat(161) })).status).toBe(422)
    expect((await patch({ coverColor: 'red' })).status).toBe(422)
    expect((await patch({ coverColor: 'url(x)' })).status).toBe(422)
    expect((await patch({ website: 'javascript:alert(1)' })).status).toBe(422)
    expect((await patch({ website: 'example.org' })).status).toBe(422)
    // Empty clears a field.
    expect((await patch({ tagline: '', coverColor: null })).status).toBe(200)
    expect(await (await call('/api/accounts/org')).json()).toMatchObject({
      tagline: null,
      coverColor: null,
    })
  })

  it('pins up to four of its own collections, and hides a private pin from outsiders', async () => {
    const { call, trees, dogs, notes, theirs } = await org()
    const pin = (pinned: unknown) =>
      call('/api/accounts/org', { method: 'PATCH', user: 'u1', json: { pinned } })

    expect((await pin([theirs.id])).status).toBe(422)
    expect((await pin([trees.id, trees.id])).status).toBe(422)
    expect((await pin(['a', 'b', 'c', 'd', 'e'])).status).toBe(422)
    expect((await pin('nope')).status).toBe(422)
    expect((await pin([notes.id, dogs.id, trees.id])).status).toBe(200)

    expect((await (await call('/api/accounts/org')).json()).pinned).toEqual([dogs.id, trees.id])
    expect((await (await call('/api/accounts/org', { user: 'u1' })).json()).pinned).toEqual([
      notes.id,
      dogs.id,
      trees.id,
    ])
    const list = (await (await call('/api/accounts/org/collections')).json()) as any[]
    expect(Object.fromEntries(list.map((c) => [c.slug, c.pinned]))).toEqual({
      dogs: 1,
      trees: 2,
    })
  })

  it('lists collections with what their head version holds', async () => {
    const { call } = await org()
    const anon = (await (await call('/api/accounts/org/collections')).json()) as any[]
    const trees = anon.find((c) => c.slug === 'trees')
    expect(trees).toMatchObject({
      name: 'Street Trees',
      description: 'Every street tree',
      tags: ['Environment'],
      license: 'CC0-1.0',
      latestVersion: '1.1.0',
      recordCount: 12,
      totalBytes: 900,
      typeCounts: { Tree: 12 },
    })
    expect(anon.find((c) => c.slug === 'dogs')).toMatchObject({
      latestVersion: null,
      recordCount: null,
    })
    expect(anon.map((c) => c.slug)).not.toContain('notes')
    // Members see private collections and private counts.
    const mine = (await (
      await call('/api/accounts/org/collections', { user: 'u1' })
    ).json()) as any[]
    expect(mine.map((c) => c.slug).sort()).toEqual(['dogs', 'notes', 'trees'])
    expect(mine.find((c) => c.slug === 'trees')).toMatchObject({
      recordCount: 13,
      typeCounts: { Tree: 12, Secret: 1 },
    })
  })

  it('lists recent versions across the collections the caller may see', async () => {
    const { call } = await org()
    const anon = (await (await call('/api/accounts/org/activity')).json()) as any[]
    expect(anon.map((a) => [a.collectionSlug, a.semver, a.recordCount])).toEqual([
      ['trees', '1.1.0', 12],
      ['dogs', '1.0.0', 5],
      ['trees', '1.0.0', 10],
    ])
    expect(anon[0]).toMatchObject({ collectionName: 'Street Trees', message: 'Push 12 records' })
    const mine = (await (await call('/api/accounts/org/activity', { user: 'u1' })).json()) as any[]
    expect(mine.map((a) => a.collectionSlug)).toEqual(['notes', 'trees', 'dogs', 'trees'])
    expect((await call('/api/accounts/nobody/activity')).status).toBe(404)
  })
})
