import type { LoaderFunctionArgs } from 'react-router'

import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) => `${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = ssrHeaders(request)

  const [account, collections, members] = await Promise.all([
    apiFetch(new URL(`/api/accounts/${params.owner}`, base), { headers }).then((r) =>
      r.ok ? r.json() : null,
    ),
    apiFetch(new URL(`/api/accounts/${params.owner}/collections`, base), { headers }).then((r) =>
      r.ok ? r.json() : [],
    ),
    apiFetch(new URL(`/api/accounts/${params.owner}/members`, base), { headers }).then((r) =>
      r.ok ? r.json() : [],
    ),
  ])

  if (!account) throw new Response('Not Found', { status: 404 })
  return { account, collections, members }
}
