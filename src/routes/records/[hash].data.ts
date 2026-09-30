import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase, ssrHeaders } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: () => `Record · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = ssrHeaders(request)
  const res = await fetch(api(`/api/records/${params.hash}/provenance`), { headers })
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
