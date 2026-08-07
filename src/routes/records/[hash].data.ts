import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: () => `Record · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const res = await fetch(api(`/api/records/${params.hash}/provenance`), { headers })
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
