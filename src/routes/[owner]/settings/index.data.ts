import type { LoaderFunctionArgs } from 'react-router'

export const handle = {
  title: (params: Record<string, string>) => `Settings — ${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = new URL(request.url).origin
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }

  const [orgData, kfOrgs] = await Promise.all([
    fetch(new URL(`/api/accounts/${params.owner}`, base), { headers }).then((r) =>
      r.ok ? r.json() : null,
    ),
    fetch(new URL('/api/accounts/available-kf-orgs', base), { headers }).then((r) =>
      r.ok ? r.json() : [],
    ),
  ])

  if (!orgData) throw new Response('Not Found', { status: 404 })
  return { orgData, kfOrgs: Array.isArray(kfOrgs) ? kfOrgs : [] }
}
