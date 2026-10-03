import type { LoaderFunctionArgs } from 'react-router'

import { features } from '~/lib/features'
import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'

export const handle = { title: 'Protocol · Underlay' }

export async function loader({ request }: LoaderFunctionArgs) {
  if (!features.discussion) return { counts: {} }
  const base = fetchBase(request.url)
  const res = await apiFetch(new URL('/api/pages/protocol/comments', base), {
    headers: ssrHeaders(request),
  })
  if (!res.ok) return { counts: {} }
  const data = await res.json()
  const counts: Record<string, number> = {}
  for (const [anchor, list] of Object.entries(data.comments ?? {})) {
    counts[anchor] = (list as any[]).filter(
      (c) => c.approvedAt && !c.parentId && c.status === 'open',
    ).length
  }
  return { counts }
}
