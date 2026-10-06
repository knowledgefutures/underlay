import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) => `${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = loaderApi(request)

  const [account, collections, members] = await Promise.all([
    api.json(`/api/accounts/${params.owner}`, null),
    api.json(`/api/accounts/${params.owner}/collections`, []),
    api.json(`/api/accounts/${params.owner}/members`, []),
  ])

  if (!account) throw new Response('Not Found', { status: 404 })
  return { account, collections, members }
}
