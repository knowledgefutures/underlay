import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) => `${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const data = await loaderApi(request, { share: true }).json(
    `/api/collections/${params.owner}/${params.collection}`,
    null,
  )
  if (!data) throw new Response('Not Found', { status: 404 })
  return data
}
