import { redirect, type LoaderFunctionArgs } from 'react-router'

import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'
import { loadSchemas } from '~/lib/schemas'
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
  const headers = ssrHeaders(request)
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, schemas] = await Promise.all([
    apiFetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null)),
    loadSchemas(api, headers, prefix, params.n ?? ''),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, schemas }
}
