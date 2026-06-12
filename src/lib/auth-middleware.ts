import { redirect, type MiddlewareFunction } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'

export const requireAuth: MiddlewareFunction = async ({ request }, next) => {
  const res = await fetch(`${fetchBase(request.url)}/api/context`, {
    headers: { Cookie: request.headers.get('Cookie') ?? '' },
  })
  const { currentUser } = await res.json()
  if (!currentUser) throw redirect('/login')
  return next()
}
