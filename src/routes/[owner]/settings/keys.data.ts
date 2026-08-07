import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { fetchBase } from '~/lib/fetch-base'

export const middleware = [requireAuth]

export const handle = {
  title: (params: Record<string, string>) => `API Keys — ${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }

  const res = await fetch(new URL(`/api/accounts/${params.owner}/collections`, base), { headers })
  const collections = res.ok ? await res.json() : []
  return { collections }
}
