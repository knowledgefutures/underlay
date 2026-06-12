import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) => `Members — ${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }

  const res = await fetch(new URL(`/api/accounts/${params.owner}`, base), { headers })
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return { orgData: await res.json() }
}
