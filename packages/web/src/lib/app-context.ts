import { useRouteLoaderData } from 'react-router'

export function useAppContext() {
  return useRouteLoaderData('root') as {
    currentUser: any // includes kfRole: string | null
    kfAccountUrl: string
    kfAuthUrl: string
    /** This deployment's host, like underlay.org or staging.underlay.org. */
    siteHost?: string
  }
}
