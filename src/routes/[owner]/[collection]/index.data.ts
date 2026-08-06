import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) => `${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const res = await fetch(api(`/api/collections/${params.owner}/${params.collection}`), {
    headers: { Cookie: request.headers.get('Cookie') ?? '' },
  })
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
