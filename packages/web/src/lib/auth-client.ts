import { apiKeyClient } from '@better-auth/api-key/client'
import { genericOAuthClient } from 'better-auth/client/plugins'
import { organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : '',
  plugins: [genericOAuthClient(), organizationClient(), apiKeyClient()],
})
