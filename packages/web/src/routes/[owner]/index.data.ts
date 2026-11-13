import type { LoaderFunctionArgs } from 'react-router'

import type { OrgCollection } from '~/components/org-page'
import { loaderApi } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) => `${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = loaderApi(request)
  const owner = params.owner!

  const [account, collections, members, activity] = await Promise.all([
    api.json(`/api/accounts/${owner}`, null),
    api.json<OrgCollection[]>(`/api/accounts/${owner}/collections`, []),
    api.json(`/api/accounts/${owner}/members`, []),
    api.json(`/api/accounts/${owner}/activity?limit=20`, []),
  ])
  if (!account) throw new Response('Not Found', { status: 404 })

  // One collection fills the page: its readme, version count, and one record of its
  // largest type, so a visitor sees what the data looks like.
  let spotlight: {
    versionCount: number | null
    readme: string | null
    sample: { type: string; data: unknown } | null
  } | null = null
  const only = collections.length === 1 ? collections[0]! : null
  if (only) {
    const base = `/api/collections/${owner}/${only.slug}`
    const largest = Object.entries(only.typeCounts ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0]
    const [detail, page] = await Promise.all([
      api.json<any>(base, null),
      only.latestVersion && largest
        ? api.json<any>(
            `${base}/versions/latest/records?type=${encodeURIComponent(largest)}&limit=1`,
            null,
          )
        : Promise.resolve(null),
    ])
    const record = page?.records?.[0]
    spotlight = {
      versionCount: detail?.versionCount ?? null,
      readme: detail?.latestVersion?.metadata?.readme ?? null,
      sample: record ? { type: record.type, data: record.data } : null,
    }
  }

  return {
    account,
    collections,
    members,
    activity,
    spotlight,
    origin: new URL(request.url).origin,
  }
}
