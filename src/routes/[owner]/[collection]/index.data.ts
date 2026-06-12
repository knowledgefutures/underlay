import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) => `${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const res = await fetch(
    new URL(`/api/collections/${params.owner}/${params.collection}`, fetchBase(request.url)),
    { headers: { Cookie: request.headers.get('Cookie') ?? '' } },
  )
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
