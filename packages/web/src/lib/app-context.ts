import { useRouteLoaderData } from 'react-router'

export function useAppContext() {
  return useRouteLoaderData('root') as {
    currentUser: any // includes kfRole: string | null
    kfAccountUrl: string
    kfAuthUrl: string
    /** This deployment's host, like underlay.org or staging.underlay.org. */
    siteHost?: string
    /** This deployment's public assets bucket (org logos and covers), or null. */
    assetsBaseUrl?: string | null
  }
}
