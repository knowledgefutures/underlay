import { useRouteLoaderData } from 'react-router'

import type { PublicMirrorConfig } from '~/lib/mirror-config'

export function useAppContext() {
  return useRouteLoaderData('root') as {
    currentUser: any // includes kfRole: string | null
    mirrorConfig: PublicMirrorConfig
    kfAccountUrl: string
    kfAuthUrl: string
  }
}
