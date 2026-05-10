export interface RouteConfig {
  path: string
  id: string
}

export const routes: RouteConfig[] = [
  // Public pages
  { path: '/', id: 'home' },
  { path: '/explore', id: 'explore' },
  { path: '/query', id: 'query' },
  { path: '/login', id: 'login' },
  { path: '/signup', id: 'signup' },
  { path: '/logout', id: 'logout' },
  { path: '/forgot-password', id: 'forgot-password' },
  { path: '/reset-password', id: 'reset-password' },

  // Schemas
  { path: '/schemas', id: 'schemas' },
  { path: '/schemas/:id', id: 'schema-detail' },

  // Blog
  { path: '/blog', id: 'blog' },
  { path: '/blog/:slug', id: 'blog-post' },

  // Docs
  { path: '/docs', id: 'docs' },
  { path: '/docs/concepts', id: 'docs-concepts' },
  { path: '/docs/quickstart', id: 'docs-quickstart' },
  { path: '/docs/integration', id: 'docs-integration' },
  { path: '/docs/self-host', id: 'docs-self-host' },
  { path: '/docs/api', id: 'docs-api' },
  { path: '/docs/api/accounts', id: 'docs-api-accounts' },
  { path: '/docs/api/collections', id: 'docs-api-collections' },
  { path: '/docs/api/versions', id: 'docs-api-versions' },
  { path: '/docs/api/files', id: 'docs-api-files' },

  // Auth-required pages
  { path: '/dashboard', id: 'dashboard' },
  { path: '/settings', id: 'settings' },
  { path: '/settings/keys', id: 'settings-keys' },
  { path: '/settings/sessions', id: 'settings-sessions' },
  { path: '/settings/avatar', id: 'settings-avatar' },
  { path: '/invitations/accept', id: 'invitations-accept' },

  // Admin
  { path: '/admin/mirror', id: 'admin-mirror' },

  // Dynamic owner/collection routes (must come last — catch-all patterns)
  { path: '/:owner', id: 'owner' },
  { path: '/:owner/settings', id: 'owner-settings' },
  { path: '/:owner/settings/keys', id: 'owner-settings-keys' },
  { path: '/:owner/settings/members', id: 'owner-settings-members' },
  { path: '/:owner/:collection', id: 'collection' },
  { path: '/:owner/:collection/versions', id: 'collection-versions' },
  { path: '/:owner/:collection/v/:n', id: 'collection-version' },
  { path: '/:owner/:collection/schemas', id: 'collection-schemas' },
  { path: '/:owner/:collection/diff', id: 'collection-diff' },
  { path: '/:owner/:collection/settings', id: 'collection-settings' },
]
