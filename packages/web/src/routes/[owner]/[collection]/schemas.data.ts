import { redirect, type LoaderFunctionArgs } from 'react-router'

import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'
import { loadSchemas } from '~/lib/schemas'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `Schemas — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const url = new URL(request.url)

  // Legacy: version-pinned schemas used to live here as ?version=.
  const versionParam = url.searchParams.get('version')
  if (versionParam) {
    const token = url.searchParams.get('token')
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : ''
    throw redirect(
      `/${params.owner}/${params.collection}/v/${versionParam.replace(/^v/, '')}/schemas${tokenQuery}`,
    )
  }

  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = ssrHeaders(request)
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, schemas] = await Promise.all([
    apiFetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null)),
    loadSchemas(api, headers, prefix, null),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, schemas }
}
