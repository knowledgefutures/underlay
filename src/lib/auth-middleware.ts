import { redirect, type MiddlewareFunction } from 'react-router'

import { fetchBase, ssrHeaders } from '~/lib/fetch-base'

export const requireAuth: MiddlewareFunction = async ({ request }, next) => {
  const res = await fetch(`${fetchBase(request.url)}/api/context`, {
    headers: ssrHeaders(request),
  })
  const { currentUser } = await res.json()
  if (!currentUser) throw redirect('/login')
  return next()
}
