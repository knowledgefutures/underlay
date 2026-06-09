import { PassThrough } from 'node:stream'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToPipeableStream } from 'react-dom/server'
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router'

import { routes } from '~/App'

const handler = createStaticHandler(routes, { future: { v8_middleware: true } })

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
    return {
      html: '',
      hydrationData: '{}',
      redirect: context.headers.get('Location') ?? '/',
      statusCode: context.status,
    }
  }

  // Extract title from deepest matched route's handle
  let title: string | undefined
  let description: string | undefined
  for (let i = context.matches.length - 1; i >= 0; i--) {
    const match = context.matches[i]!
    const handle = match.route.handle as
      | {
          title?: string | ((p: Record<string, string>, d: unknown) => string)
          description?: string | ((p: Record<string, string>, d: unknown) => string)
        }
      | undefined
    if (handle?.title && !title) {
      title =
        typeof handle.title === 'function'
          ? handle.title(
              match.params as Record<string, string>,
              context.loaderData[match.route.id!],
            )
          : handle.title
    }
    if (handle?.description && !description) {
      description =
        typeof handle.description === 'function'
          ? handle.description(
              match.params as Record<string, string>,
              context.loaderData[match.route.id!],
            )
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

    const queryClient = new QueryClient()
    const { pipe } = renderToPipeableStream(
      <QueryClientProvider client={queryClient}>
        <StaticRouterProvider router={router} context={context} />
      </QueryClientProvider>,
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
              ...(context.statusCode !== 200 && { statusCode: context.statusCode }),
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
