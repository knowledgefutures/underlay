import { PassThrough } from 'node:stream'

import { renderToPipeableStream } from 'react-dom/server'
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router'

import { routes } from '~/App'

const handler = createStaticHandler(routes)

export async function render(request: Request): Promise<{
  html: string
  hydrationData: string
  redirect?: string
  statusCode?: number
  title?: string
  description?: string
}> {
  const context = await handler.query(request)

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

  // Extract title and description from the deepest matched route's handle
  let title: string | undefined
  let description: string | undefined
  for (let i = context.matches.length - 1; i >= 0; i--) {
    const match = context.matches[i]!
    const handle = match.route.handle as
      | {
          title?: string | ((params: Record<string, string>, loaderData: unknown) => string)
          description?: string | ((params: Record<string, string>, loaderData: unknown) => string)
        }
      | undefined

    if (handle?.title && !title) {
      title =
        typeof handle.title === 'function'
          ? handle.title(match.params as Record<string, string>, context.loaderData)
          : handle.title
    }
    if (handle?.description && !description) {
      description =
        typeof handle.description === 'function'
          ? handle.description(match.params as Record<string, string>, context.loaderData)
          : handle.description
    }
    if (title && description) break
  }

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
