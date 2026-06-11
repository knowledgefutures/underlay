import { useRouteLoaderData } from 'react-router'

export function useAppContext() {
  return useRouteLoaderData('root') as {
    currentUser: any // includes kfRole: string | null
    mirrorConfig: {
      enabled: boolean
      upstream: string
      nodeName: string
      syncSchedule: string
      apiKey: string
    }
    kfAccountUrl: string
    kfAuthUrl: string
  }
}
