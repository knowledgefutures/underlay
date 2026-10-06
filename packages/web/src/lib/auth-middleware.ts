import { redirect, type MiddlewareFunction } from 'react-router'

import { fetchContext } from '~/lib/fetch-base'

export const requireAuth: MiddlewareFunction = async ({ request }, next) => {
  // A failed context lookup counts as signed out rather than failing the render.
  const { currentUser } = await fetchContext(request)
  if (!currentUser) throw redirect('/login')
  return next()
}
