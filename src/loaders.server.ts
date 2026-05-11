import { getSessionUser, } from '~/lib/auth.server'
import { getMirrorConfig, } from '~/lib/mirror-config'

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

type LoaderFn = (ctx: LoaderContext,) => LoaderResult | Promise<LoaderResult>

const mirrorConfig = getMirrorConfig()

// Shared helper: require auth or redirect to login
async function requireUser(request: Request,): Promise<{ user: any; redirect?: string }> {
  const user = await getSessionUser(request,)
  if (!user) {
    return { user: null, redirect: '/login', }
  }
  return { user, }
}

const loaders: Record<string, LoaderFn> = {
  // --- Public pages ---
  '/': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: mirrorConfig.enabled
        ? `Underlay · ${mirrorConfig.nodeName}`
        : 'Underlay — A public registry for structured knowledge',
    }
  },

  '/explore': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Explore — Underlay',
    }
  },

  '/query': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Query Explorer — Underlay',
    }
  },

  '/schemas': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Schemas — Underlay',
    }
  },

  '/schemas/:id': async ({ params, request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, schemaId: params['id'], },
      title: 'Schema — Underlay',
    }
  },

  // --- Auth pages ---
  '/login': async ({ request, },) => {
    const user = await getSessionUser(request,)
    if (user) return { data: {}, redirect: '/dashboard', }
    return {
      data: { currentUser: null, mirrorConfig, },
      title: 'Log in — Underlay',
    }
  },

  '/signup': async ({ request, },) => {
    const user = await getSessionUser(request,)
    if (user) return { data: {}, redirect: '/dashboard', }
    return {
      data: { currentUser: null, mirrorConfig, },
      title: 'Sign up — Underlay',
    }
  },

  '/logout': async () => {
    return { data: {}, redirect: '/login', }
  },

  '/forgot-password': async () => {
    return {
      data: { currentUser: null, mirrorConfig, },
      title: 'Forgot password — Underlay',
    }
  },

  '/reset-password': async () => {
    return {
      data: { currentUser: null, mirrorConfig, },
      title: 'Reset password — Underlay',
    }
  },

  // --- Dashboard/Settings ---
  '/dashboard': async ({ request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Dashboard — Underlay',
    }
  },

  '/settings': async ({ request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Settings — Underlay',
    }
  },

  '/settings/keys': async ({ request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'API Keys — Underlay',
    }
  },

  '/settings/sessions': async ({ request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Sessions — Underlay',
    }
  },

  '/settings/avatar': async ({ request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Avatar — Underlay',
    }
  },

  '/invitations/accept': async ({ request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Accept Invitation — Underlay',
    }
  },

  '/admin/mirror': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Mirror Admin — Underlay',
    }
  },

  // --- Blog ---
  '/blog': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Blog — Underlay',
    }
  },

  '/blog/:slug': async ({ params, request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, slug: params['slug'], },
      title: 'Blog — Underlay',
    }
  },

  // --- Docs ---
  '/docs': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Documentation — Underlay',
    }
  },

  '/docs/concepts': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Core Concepts — Underlay Docs',
    }
  },

  '/docs/quickstart': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Quickstart — Underlay Docs',
    }
  },

  '/docs/integration': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Integration — Underlay Docs',
    }
  },

  '/docs/self-host': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Self-hosting — Underlay Docs',
    }
  },

  '/docs/api': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'API Reference — Underlay Docs',
    }
  },

  '/docs/api/accounts': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Accounts API — Underlay Docs',
    }
  },

  '/docs/api/collections': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Collections API — Underlay Docs',
    }
  },

  '/docs/api/versions': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Versions API — Underlay Docs',
    }
  },

  '/docs/api/files': async ({ request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, },
      title: 'Files API — Underlay Docs',
    }
  },

  // --- Dynamic owner/collection ---
  '/:owner': async ({ params, request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: { currentUser: user, mirrorConfig, owner: params['owner'], },
      title: `${params['owner']} — Underlay`,
    }
  },

  '/:owner/settings': async ({ params, request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, owner: params['owner'], },
      title: `Settings — ${params['owner']} — Underlay`,
    }
  },

  '/:owner/settings/keys': async ({ params, request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, owner: params['owner'], },
      title: `API Keys — ${params['owner']} — Underlay`,
    }
  },

  '/:owner/settings/members': async ({ params, request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
    return {
      data: { currentUser: user, mirrorConfig, owner: params['owner'], },
      title: `Members — ${params['owner']} — Underlay`,
    }
  },

  '/:owner/:collection': async ({ params, request, },) => {
    const user = await getSessionUser(request,)
    return {
      data: {
        currentUser: user,
        mirrorConfig,
        owner: params['owner'],
        collection: params['collection'],
      },
      title: `${params['owner']}/${params['collection']} — Underlay`,
    }
  },

  '/:owner/:collection/versions': async ({ params, request, },) => {
    const user = await getSessionUser(request,)
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

  '/:owner/:collection/v/:n': async ({ params, request, },) => {
    const user = await getSessionUser(request,)
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

  '/:owner/:collection/schemas': async ({ params, request, },) => {
    const user = await getSessionUser(request,)
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

  '/:owner/:collection/diff': async ({ params, request, },) => {
    const user = await getSessionUser(request,)
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

  '/:owner/:collection/settings': async ({ params, request, },) => {
    const { user, redirect, } = await requireUser(request,)
    if (redirect) return { data: {}, redirect, }
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

export async function runLoaders(
  matchedRoutes: { path: string; params: Record<string, string> }[],
  request: Request,
): Promise<LoaderResult> {
  for (const { path, params, } of matchedRoutes) {
    const loader = loaders[path]
    if (loader) {
      return loader({ params, request, },)
    }
  }

  // No loader found — return empty data
  return { data: {}, }
}
