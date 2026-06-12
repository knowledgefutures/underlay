import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) => `${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }

  const [account, collections, members] = await Promise.all([
    fetch(new URL(`/api/accounts/${params.owner}`, base), { headers }).then((r) =>
      r.ok ? r.json() : null,
    ),
    fetch(new URL(`/api/accounts/${params.owner}/collections`, base), { headers }).then((r) =>
      r.ok ? r.json() : [],
    ),
    fetch(new URL(`/api/accounts/${params.owner}/members`, base), { headers }).then((r) =>
      r.ok ? r.json() : [],
    ),
  ])

  if (!account) throw new Response('Not Found', { status: 404 })
  return { account, collections, members }
}
