import { useRouteLoaderData } from 'react-router'

export interface AppContext {
  currentUser: any
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

export function useAppContext(): AppContext {
  return useRouteLoaderData('root') as AppContext
}
