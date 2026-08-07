import { requireAuth } from '~/lib/auth-middleware'

export const middleware = [requireAuth]

export const handle = {
  title: (params: Record<string, string>) => `Members — ${params.owner} · Underlay`,
}
