import { eq } from 'drizzle-orm'
import { afterAll, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

async function setup() {
  const h = await harness()
  const { db } = h.ports
  await db.insert(schema.organization).values({ id: 'org2', name: 'Space Agency', slug: 'nasa' })
  const exo = await h.collection('exoplanets')
  const quakes = await h.collection('quakes')
  const hidden = await h.collection('nasa-notes')
  await db
    .update(schema.collections)
    .set({ organizationId: 'org2', public: true, name: 'Exoplanet Archive' })
    .where(eq(schema.collections.id, exo.id))
  await db
    .update(schema.collections)
    .set({
      public: true,
      name: 'Earthquake Catalog',
      summary: { description: 'Significant earthquakes worldwide' },
    })
    .where(eq(schema.collections.id, quakes.id))
  // Private: never found, and its owner is not listed for it.
  await db
    .update(schema.collections)
    .set({ organizationId: 'org2', name: 'Internal notes' })
    .where(eq(schema.collections.id, hidden.id))
  return h
}

async function search(h: Awaited<ReturnType<typeof harness>>, q: string) {
  const res = await h.request(`/api/collections?q=${encodeURIComponent(q)}`)
  expect(res.status).toBe(200)
  return (await res.json()) as any
}

it('searches collection names, descriptions and owners, and lists matching organizations', async () => {
  const h = await setup()

  const byOwner = await search(h, 'space agency')
  expect(byOwner.collections.map((c: any) => c.slug)).toEqual(['exoplanets'])
  expect(byOwner.organizations).toEqual([
    { slug: 'nasa', name: 'Space Agency', avatarUrl: null, coverColor: null, count: 1 },
  ])

  const bySlug = await search(h, 'nasa')
  expect(bySlug.collections.map((c: any) => c.slug)).toEqual(['exoplanets'])
  expect(bySlug.organizations.map((o: any) => o.slug)).toEqual(['nasa'])

  const byDescription = await search(h, 'worldwide')
  expect(byDescription.collections.map((c: any) => c.slug)).toEqual(['quakes'])
  expect(byDescription.organizations).toEqual([])

  const none = await search(h, 'internal')
  expect(none.collections).toEqual([])

  const all = await h.request('/api/collections').then((r) => r.json() as any)
  expect(all.organizations).toEqual([])
})
