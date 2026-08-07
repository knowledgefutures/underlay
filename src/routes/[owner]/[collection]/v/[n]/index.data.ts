import { redirect, type LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `Version ${params.n} — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const bare = (params.n ?? '').replace(/^v/, '')
  const base = `/${params.owner}/${params.collection}/v/${bare}`

  // Legacy URLs: views used to be ?tab= query modes on this route.
  const tab = url.searchParams.get('tab')
  const token = url.searchParams.get('token')
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : ''
  if (tab === 'files') throw redirect(`${base}/files${tokenQuery}`)
  if (tab === 'schema') throw redirect(`${base}/schemas${tokenQuery}`)
  if (url.searchParams.get('type') || url.searchParams.get('page')) {
    const q = new URLSearchParams()
    for (const key of ['type', 'page', 'token']) {
      const value = url.searchParams.get(key)
      if (value) q.set(key, value)
    }
    throw redirect(`${base}/records?${q}`)
  }
  if (tab) throw redirect(`${base}${tokenQuery}`)
  // Canonicalize the legacy double-v form (/v/v1.0.0 → /v/1.0.0).
  if (/^v\d/.test(params.n ?? '')) throw redirect(`${base}${url.search}`)

  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [version, collectionData] = await Promise.all([
    fetch(api(`${prefix}/versions/${params.n}`), { headers }).then((r) => (r.ok ? r.json() : null)),
    fetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null)),
  ])

  if (!version) throw new Response('Not Found', { status: 404 })
  return { version, collectionData }
}
