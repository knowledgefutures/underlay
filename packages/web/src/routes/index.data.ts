import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = { title: 'Underlay' }

/** The collection the home page uses to show what a collection is and how to use it. */
const EXAMPLE_COLLECTION = { owner: 'nasa', slug: 'exoplanets' }

export interface HomeCollection {
  slug: string
  ownerSlug: string
  name: string
  description: string | null
  tags: string[]
  semver: string | null
  recordCount: number | null
}

export interface HomeExample {
  owner: string
  slug: string
  name: string
  semver: string
  recordCount: number
  ark: string | null
  typeCounts: { type: string; count: number }[]
  /** One record of the largest type, its data cut to a few short fields. */
  record: { id: string; type: string; data: Record<string, unknown> } | null
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = loaderApi(request)
  const { owner, slug } = EXAMPLE_COLLECTION
  const base = `/api/collections/${owner}/${slug}`
  const [list, info] = await Promise.all([
    api.json<any>('/api/collections?limit=6', {}),
    api.json<any>(base, null),
  ])

  // The instance's featured collections when it has picked some, else the most recently updated.
  const picked = list.featuredCollections?.length ? list.featuredCollections : list.collections
  const featured: HomeCollection[] = (picked ?? []).slice(0, 6).map((c: any) => ({
    slug: c.slug,
    ownerSlug: c.ownerSlug,
    name: c.name,
    description: c.description ?? null,
    tags: c.tags ?? [],
    // A list item's latestVersion is the semver string.
    semver: c.latestVersion ?? null,
    recordCount: c.recordCount,
  }))

  let example: HomeExample | null = null
  const v = info?.public ? info.latestVersion : null
  if (v?.semver) {
    const typeCounts: HomeExample['typeCounts'] = [...(v.typeCounts ?? [])].sort(
      (a, b) => b.count - a.count,
    )
    let record: HomeExample['record'] = null
    if (typeCounts[0]) {
      const page = await api.json<any>(
        `${base}/versions/${v.semver}/records?type=${encodeURIComponent(typeCounts[0].type)}&limit=1`,
        null,
      )
      const r = page?.records?.[0]
      if (r) {
        const short = Object.entries(r.data ?? {})
          .filter(([, value]) => value != null && typeof value !== 'object')
          .filter(([, value]) => String(value).length <= 40)
          .slice(0, 4)
        record = { id: r.id, type: r.type, data: Object.fromEntries(short) }
      }
    }
    example = {
      owner,
      slug,
      name: info.name,
      semver: v.semver,
      recordCount: v.recordCount,
      ark: v.ark ?? info.ark ?? null,
      typeCounts,
      record,
    }
  }

  return { featured, example }
}
