import { getSessionUser } from '~/lib/auth.server'
import { getCollectionPageData } from '~/lib/collections.server'
import { getMirrorConfig } from '~/lib/mirror-config'

type LoaderContext = {
  params: Record<string, string>
  request: Request
}

type LoaderResult = {
  data: Record<string, unknown>
  redirect?: string
  statusCode?: number
  title?: string
  description?: string
}

type LoaderFn = (ctx: LoaderContext) => LoaderResult | Promise<LoaderResult>

const mirrorConfig = getMirrorConfig()

async function requireUser(request: Request): Promise<{ user: any; redirect?: string }> {
  const user = await getSessionUser(request)
  if (!user) return { user: null, redirect: '/login' }
  return { user }
}

function page(title: string, extra?: Record<string, unknown>): LoaderFn {
  return async ({ request }) => {
    const user = await getSessionUser(request)
    return { data: { currentUser: user, mirrorConfig, ...extra }, title }
  }
}

function authPage(title: string, extra?: Record<string, unknown>): LoaderFn {
  return async ({ request }) => {
    const { user, redirect } = await requireUser(request)
    if (redirect) return { data: {}, redirect }
    return { data: { currentUser: user, mirrorConfig, ...extra }, title }
  }
}

const loaders: Record<string, LoaderFn> = {
  '/': async ({ request }) => {
    const user = await getSessionUser(request)
    return {
      data: { currentUser: user, mirrorConfig },
      title: mirrorConfig.enabled
        ? `Underlay · ${mirrorConfig.nodeName}`
        : 'Underlay — A public registry for structured knowledge',
    }
  },

  '/explore': page('Explore — Underlay'),
  '/query': page('Query Explorer — Underlay'),
  '/schemas': page('Schemas — Underlay'),
  '/schemas/:id': page('Schema — Underlay'),
  '/blog': page('Blog — Underlay'),
  '/blog/:slug': page('Blog — Underlay'),
  '/docs': page('Documentation — Underlay'),
  '/docs/concepts': page('Core Concepts — Underlay Docs'),
  '/docs/quickstart': page('Quickstart — Underlay Docs'),
  '/docs/integration': page('Integration — Underlay Docs'),
  '/docs/self-host': page('Self-hosting — Underlay Docs'),
  '/docs/api': page('API Reference — Underlay Docs'),
  '/docs/api/accounts': page('Accounts API — Underlay Docs'),
  '/docs/api/collections': page('Collections API — Underlay Docs'),
  '/docs/api/versions': page('Versions API — Underlay Docs'),
  '/docs/api/files': page('Files API — Underlay Docs'),
  '/admin/mirror': page('Mirror Admin — Underlay'),

  '/login': async ({ request }) => {
    const user = await getSessionUser(request)
    if (user) return { data: {}, redirect: '/dashboard' }
    return { data: { currentUser: null, mirrorConfig }, title: 'Log in — Underlay' }
  },

  '/signup': async ({ request }) => {
    const user = await getSessionUser(request)
    if (user) return { data: {}, redirect: '/dashboard' }
    return { data: { currentUser: null, mirrorConfig }, title: 'Sign up — Underlay' }
  },

  '/logout': async () => ({
    data: { kfAuthUrl: process.env.OIDC_ISSUER_URL ?? 'http://localhost:3000' },
  }),

  '/forgot-password': async () => ({
    data: { currentUser: null, mirrorConfig },
    title: 'Forgot password — Underlay',
  }),

  '/reset-password': async () => ({
    data: { currentUser: null, mirrorConfig },
    title: 'Reset password — Underlay',
  }),

  '/dashboard': authPage('Dashboard — Underlay'),
  '/settings': authPage('Settings — Underlay'),
  '/settings/keys': authPage('API Keys — Underlay'),
  '/settings/sessions': authPage('Sessions — Underlay'),
  '/settings/avatar': authPage('Avatar — Underlay'),
  '/invitations/accept': authPage('Accept Invitation — Underlay'),

  '/:owner': async ({ params, request }) => {
    const user = await getSessionUser(request)
    return {
      data: { currentUser: user, mirrorConfig },
      title: `${params['owner']} — Underlay`,
    }
  },

  '/:owner/settings': async ({ params, request }) => {
    const { user, redirect } = await requireUser(request)
    if (redirect) return { data: {}, redirect }
    return {
      data: { currentUser: user, mirrorConfig },
      title: `Settings — ${params['owner']} — Underlay`,
    }
  },

  '/:owner/settings/keys': async ({ params, request }) => {
    const { user, redirect } = await requireUser(request)
    if (redirect) return { data: {}, redirect }
    return {
      data: { currentUser: user, mirrorConfig },
      title: `API Keys — ${params['owner']} — Underlay`,
    }
  },

  '/:owner/settings/members': async ({ params, request }) => {
    const { user, redirect } = await requireUser(request)
    if (redirect) return { data: {}, redirect }
    return {
      data: { currentUser: user, mirrorConfig },
      title: `Members — ${params['owner']} — Underlay`,
    }
  },

  '/:owner/:collection': async ({ params, request }) => {
    const user = await getSessionUser(request)
    const collection = await getCollectionPageData(
      params['owner']!,
      params['collection']!,
      user?.id,
    )
    return {
      data: {
        currentUser: user,
        mirrorConfig,
        collection,
      },
      title: `${params['owner']}/${params['collection']} — Underlay`,
      ...(collection ? {} : { statusCode: 404 }),
    }
  },

  '/:owner/:collection/versions': async ({ params, request }) => {
    const user = await getSessionUser(request)
    return {
      data: {
        currentUser: user,
        mirrorConfig,
        owner: params['owner'],
        collection: params['collection'],
      },
      title: `Versions — ${params['owner']}/${params['collection']} — Underlay`,
    }
  },

  '/:owner/:collection/v/:n': async ({ params, request }) => {
    const user = await getSessionUser(request)
    return {
      data: {
        currentUser: user,
        mirrorConfig,
        owner: params['owner'],
        collection: params['collection'],
        versionNumber: params['n'],
      },
      title: `v${params['n']} — ${params['owner']}/${params['collection']} — Underlay`,
    }
  },

  '/:owner/:collection/schemas': async ({ params, request }) => {
    const user = await getSessionUser(request)
    return {
      data: {
        currentUser: user,
        mirrorConfig,
        owner: params['owner'],
        collection: params['collection'],
      },
      title: `Schemas — ${params['owner']}/${params['collection']} — Underlay`,
    }
  },

  '/:owner/:collection/diff': async ({ params, request }) => {
    const user = await getSessionUser(request)
    return {
      data: {
        currentUser: user,
        mirrorConfig,
        owner: params['owner'],
        collection: params['collection'],
      },
      title: `Diff — ${params['owner']}/${params['collection']} — Underlay`,
    }
  },

  '/:owner/:collection/settings': async ({ params, request }) => {
    const { user, redirect } = await requireUser(request)
    if (redirect) return { data: {}, redirect }
    return {
      data: {
        currentUser: user,
        mirrorConfig,
        owner: params['owner'],
        collection: params['collection'],
      },
      title: `Settings — ${params['owner']}/${params['collection']} — Underlay`,
    }
  },
}

const kfAccountUrl = process.env.OIDC_ACCOUNT_URL ?? 'http://localhost:3001'

export async function runLoaders(
  matchedRoutes: { path: string; params: Record<string, string> }[],
  request: Request,
): Promise<LoaderResult> {
  for (const { path, params } of matchedRoutes) {
    const loader = loaders[path]
    if (loader) {
      const result = await loader({ params, request })
      result.data.kfAccountUrl = kfAccountUrl
      return result
    }
  }

  // No loader found — return empty data
  return { data: { kfAccountUrl } }
}
