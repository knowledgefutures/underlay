import { PassThrough } from 'node:stream'

import { renderToPipeableStream } from 'react-dom/server'
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router'

import { routes } from '~/App'
import type { AppContext } from '~/lib/app-context'
import { getSessionUser } from '~/lib/auth.server'
import { getMirrorConfig } from '~/lib/mirror-config'
import { extractRouteMeta } from '~/lib/route-meta'

const handler = createStaticHandler(routes)

async function loadAppContext(request: Request): Promise<AppContext> {
  const user = await getSessionUser(request)
  const config = getMirrorConfig()
  return {
    currentUser: user,
    mirrorConfig: config,
    kfAccountUrl: process.env.OIDC_ACCOUNT_URL ?? 'http://localhost:3001',
    kfAuthUrl: process.env.OIDC_ISSUER_URL ?? 'http://localhost:3000',
  }
}

export async function render(request: Request): Promise<{
  html: string
  hydrationData: string
  redirect?: string
  statusCode?: number
  title?: string
  description?: string
}> {
  const context = await handler.query(request, {
    requestContext: { loadAppContext },
  })

  if (context instanceof Response) {
    const location = context.headers.get('Location')
    return {
      html: '',
      hydrationData: '{}',
      redirect: location ?? '/',
      statusCode: context.status,
    }
  }

  // Check for auth redirects via route handle metadata
  for (const match of context.matches) {
    const handle = match.route.handle as { requireAuth?: boolean } | undefined
    if (handle?.requireAuth) {
      const rootData = context.loaderData?.root as { currentUser: unknown } | undefined
      if (!rootData?.currentUser) {
        return {
          html: '',
          hydrationData: '{}',
          redirect: '/login',
          statusCode: 302,
        }
      }
    }
  }

  const { title, description } = extractRouteMeta(
    context.matches as Array<{ params: Record<string, string>; route: { handle?: unknown } }>,
    context.loaderData,
  )

  const router = createStaticRouter(handler.dataRoutes, context)

  return new Promise((resolve, reject) => {
    let html = ''
    const passthrough = new PassThrough()
    passthrough.on('data', (chunk: Buffer) => {
      html += chunk.toString()
    })

    const { pipe } = renderToPipeableStream(
      <StaticRouterProvider router={router} context={context} />,
      {
        onAllReady() {
          pipe(passthrough)
          passthrough.on('end', () => {
            const hydrationData = JSON.stringify({
              loaderData: context.loaderData,
              actionData: context.actionData ?? null,
              errors: context.errors ?? null,
            }).replace(/</g, '\\u003c')

            resolve({
              html,
              hydrationData,
              statusCode: context.statusCode,
              ...(title !== undefined && { title }),
              ...(description !== undefined && { description }),
            })
          })
        },
        onError: reject,
      },
    )
  })
}
