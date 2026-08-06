import { redirect, type LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `Schemas ${params.n} — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Canonicalize the legacy double-v form (/v/v1.0.0 → /v/1.0.0).
  if (/^v\d/.test(params.n ?? '')) {
    const url = new URL(request.url)
    const bare = (params.n ?? '').replace(/^v/, '')
    throw redirect(`/${params.owner}/${params.collection}/v/${bare}/schemas${url.search}`)
  }

  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, schemas] = await Promise.all([
    fetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null)),
    fetch(api(`${prefix}/schemas?version=${encodeURIComponent(params.n ?? '')}`), {
      headers,
    }).then((r) => (r.ok ? r.json() : null)),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, schemas }
}
