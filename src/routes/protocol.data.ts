import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'

export const handle = { title: 'Protocol · Underlay' }

export async function loader({ request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const res = await fetch(new URL('/api/pages/protocol/comments', base), {
    headers: { Cookie: request.headers.get('Cookie') ?? '' },
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
