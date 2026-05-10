import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router'
import { routes } from '~/routes'

const componentMap: Record<
  string,
  React.LazyExoticComponent<React.ComponentType>
> = {
  // Public pages
  'home': lazy(() => import('~/routes/home')),
  'explore': lazy(() => import('~/routes/explore')),
  'query': lazy(() => import('~/routes/query')),
  'login': lazy(() => import('~/routes/login')),
  'signup': lazy(() => import('~/routes/signup')),
  'logout': lazy(() => import('~/routes/logout')),
  'forgot-password': lazy(() => import('~/routes/forgot-password')),
  'reset-password': lazy(() => import('~/routes/reset-password')),

  // Schemas
  'schemas': lazy(() => import('~/routes/schemas')),
  'schema-detail': lazy(() => import('~/routes/schemas/detail')),

  // Blog
  'blog': lazy(() => import('~/routes/blog')),
  'blog-post': lazy(() => import('~/routes/blog/post')),

  // Docs
  'docs': lazy(() => import('~/routes/docs')),
  'docs-concepts': lazy(() => import('~/routes/docs/concepts')),
  'docs-quickstart': lazy(() => import('~/routes/docs/quickstart')),
  'docs-integration': lazy(() => import('~/routes/docs/integration')),
  'docs-self-host': lazy(() => import('~/routes/docs/self-host')),
  'docs-api': lazy(() => import('~/routes/docs/api')),
  'docs-api-accounts': lazy(() => import('~/routes/docs/api/accounts')),
  'docs-api-collections': lazy(() => import('~/routes/docs/api/collections')),
  'docs-api-versions': lazy(() => import('~/routes/docs/api/versions')),
  'docs-api-files': lazy(() => import('~/routes/docs/api/files')),

  // Auth-required
  'dashboard': lazy(() => import('~/routes/dashboard')),
  'settings': lazy(() => import('~/routes/settings')),
  'settings-keys': lazy(() => import('~/routes/settings/keys')),
  'settings-sessions': lazy(() => import('~/routes/settings/sessions')),
  'settings-avatar': lazy(() => import('~/routes/settings/avatar')),
  'invitations-accept': lazy(() => import('~/routes/invitations/accept')),

  // Admin
  'admin-mirror': lazy(() => import('~/routes/admin/mirror')),

  // Dynamic owner/collection
  'owner': lazy(() => import('~/routes/owner')),
  'owner-settings': lazy(() => import('~/routes/owner/settings')),
  'owner-settings-keys': lazy(() => import('~/routes/owner/settings-keys')),
  'owner-settings-members': lazy(() => import('~/routes/owner/settings-members')),
  'collection': lazy(() => import('~/routes/collection')),
  'collection-versions': lazy(() => import('~/routes/collection/versions')),
  'collection-version': lazy(() => import('~/routes/collection/version')),
  'collection-schemas': lazy(() => import('~/routes/collection/schemas')),
  'collection-diff': lazy(() => import('~/routes/collection/diff')),
  'collection-settings': lazy(() => import('~/routes/collection/settings')),
}

export default function App() {
  return (
    <Suspense>
      <Routes>
        {routes.map((r) => {
          const Page = componentMap[r.id]
          return Page ? (
            <Route key={r.id} path={r.path} element={<Page />} />
          ) : null
        })}
      </Routes>
    </Suspense>
  )
}
