import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = { title: 'Protocol · Underlay' }

export async function loader({ request }: LoaderFunctionArgs) {
  const data = await loaderApi(request).json<any>('/api/pages/protocol/comments', {})
  const counts: Record<string, number> = {}
  for (const [anchor, list] of Object.entries(data.comments ?? {})) {
    counts[anchor] = (list as any[]).filter(
      (c) => c.approvedAt && !c.parentId && c.status === 'open',
    ).length
  }
  return { counts }
}
