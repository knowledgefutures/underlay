import { requireAuth } from '~/lib/auth-middleware'

export const middleware = [requireAuth]
export const handle = { title: 'API Keys — Underlay' }
