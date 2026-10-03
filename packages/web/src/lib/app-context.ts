import { useRouteLoaderData } from 'react-router'

export function useAppContext() {
  return useRouteLoaderData('root') as {
    currentUser: any // includes kfRole: string | null
    kfAccountUrl: string
    kfAuthUrl: string
  }
}
