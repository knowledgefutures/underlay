import type { LoaderFunctionArgs } from 'react-router'

export const handle = { title: 'Underlay' }

export async function loader({ request }: LoaderFunctionArgs) {
  const base = new URL(request.url).origin
  const res = await fetch(new URL('/api/collections?sort=featured&take=6', base), {
    headers: { Cookie: request.headers.get('Cookie') ?? '' },
  })
  if (!res.ok) return { featured: [] }
  const data = await res.json()
  const collections = (data.collections ?? []).slice(0, 6).map((c: any) => ({
    slug: c.slug,
    ownerSlug: c.ownerSlug,
    description: c.description,
    semver: c.semver,
    recordCount: c.recordCount,
    totalBytes: c.totalBytes,
    lastPushAt: c.lastPushAt,
  }))
  return { featured: collections }
}
