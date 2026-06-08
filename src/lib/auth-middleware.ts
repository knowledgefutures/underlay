import { redirect, type MiddlewareFunction } from 'react-router'

export const requireAuth: MiddlewareFunction = async ({ request }, next) => {
  const res = await fetch(new URL('/api/context', request.url), {
    headers: { Cookie: request.headers.get('Cookie') ?? '' },
  })
  const { currentUser } = await res.json()
  if (!currentUser) throw redirect('/login')
  return next()
}
