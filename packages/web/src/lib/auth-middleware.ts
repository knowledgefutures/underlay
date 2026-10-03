import { redirect, type MiddlewareFunction } from 'react-router'

import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'

export const requireAuth: MiddlewareFunction = async ({ request }, next) => {
  const res = await apiFetch(`${fetchBase(request.url)}/api/context`, {
    headers: ssrHeaders(request),
  })
  // A failed context lookup counts as signed out rather than failing the render.
  const { currentUser } = res.ok ? await res.json() : { currentUser: null }
  if (!currentUser) throw redirect('/login')
  return next()
}
