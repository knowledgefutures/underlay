import type { LoaderFunctionArgs } from 'react-router'

import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'

export const handle = { title: 'Underlay' }

export async function loader({ request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const res = await apiFetch(new URL('/api/collections?limit=6', base), {
    headers: ssrHeaders(request),
  })
  if (!res.ok) return { featured: [] }
  const data = await res.json()
  // The instance's featured collections when it has picked some, else the most recently updated.
  const list = data.featuredCollections?.length ? data.featuredCollections : data.collections
  const collections = (list ?? []).slice(0, 6).map((c: any) => ({
    slug: c.slug,
    ownerSlug: c.ownerSlug,
    description: c.description,
    // A list item's latestVersion is the semver string (v1 read a `semver` field that never existed).
    semver: c.latestVersion ?? null,
    recordCount: c.recordCount,
    totalBytes: c.totalBytes,
    lastPushAt: c.lastPushAt,
  }))
  return { featured: collections }
}
