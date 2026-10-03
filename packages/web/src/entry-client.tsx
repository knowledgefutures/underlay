import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { hydrateRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'

import { routes } from '~/App'

import '~/global.css'

const queryClient = new QueryClient()

const router = createBrowserRouter(routes, {
  hydrationData: (window as any).__staticRouterHydrationData,
  future: { v8_middleware: true },
})

// Wait for React.lazy route components to resolve before hydrating
if (!router.state.initialized) {
  await new Promise<void>((resolve) => {
    const unsub = router.subscribe((state) => {
      if (state.initialized) {
        unsub()
        resolve()
      }
    })
  })
}

hydrateRoot(
  document.getElementById('root')!,
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
)
