import { Outlet } from 'react-router'

import { AppErrorBoundary } from '~/components/NotFound'

export default function Root() {
  return (
    <AppErrorBoundary>
      <Outlet />
    </AppErrorBoundary>
  )
}
