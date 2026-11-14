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

  return {
    account,
    collections,
    members,
    activity,
    origin: new URL(request.url).origin,
  }
}
