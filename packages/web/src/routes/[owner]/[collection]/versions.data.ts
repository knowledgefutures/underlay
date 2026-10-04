import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) =>
    `Versions — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = loaderApi(request, { share: true })
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, versions] = await Promise.all([
    api.json(prefix, null),
    api.json(`${prefix}/versions?limit=100`, []),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, versions }
}
