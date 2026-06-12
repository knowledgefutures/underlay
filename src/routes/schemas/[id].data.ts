import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'

export const handle = {
  title: () => `Schema · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const res = await fetch(new URL(`/api/schemas/${params.id}`, base), { headers })
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
