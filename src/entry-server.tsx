import { PassThrough } from 'node:stream'

import { renderToPipeableStream } from 'react-dom/server'
import { StaticRouter } from 'react-router'

import App, { routes } from '~/App'
import { SSRDataProvider } from '~/lib/ssr-data'
import { runLoaders } from '~/loaders.server'
import { matchRoutes } from '~/route-gen'

export async function loadData(
  request: Request,
): Promise<{
  data: Record<string, unknown>
  redirect?: string
  statusCode?: number
  title?: string
  description?: string
}> {
  return runLoaders(matchRoutes(routes, request.url), request)
}

export async function render(request: Request): Promise<{
  html: string
  ssrData: Record<string, unknown>
  redirect?: string
  statusCode?: number
  title?: string
  description?: string
}> {
  const pathname = new URL(request.url, 'http://localhost').pathname

  let ssrData: Record<string, unknown>
  let redirect: string | undefined
  let statusCode: number | undefined
  let title: string | undefined
  let description: string | undefined

  try {
    const result = await loadData(request)
    ssrData = result.data
    redirect = result.redirect
    statusCode = result.statusCode
    title = result.title
    description = result.description
  } catch (err) {
    console.error('Loader error:', err)
    ssrData = {}
    statusCode = 500
  }

  if (redirect) {
    return { html: '', ssrData: {}, redirect, statusCode: statusCode ?? 302 }
  }

  return new Promise((resolve, reject) => {
    let html = ''
    const passthrough = new PassThrough()
    passthrough.on('data', (chunk) => {
      html += chunk.toString()
    })

    const { pipe } = renderToPipeableStream(
      <StaticRouter location={pathname}>
        <SSRDataProvider data={ssrData}>
          <App />
        </SSRDataProvider>
      </StaticRouter>,
      {
        onAllReady() {
          pipe(passthrough)
          passthrough.on('end', () =>
            resolve({
              html,
              ssrData,
              ...(statusCode !== undefined && { statusCode }),
              ...(title !== undefined && { title }),
              ...(description !== undefined && { description }),
            }),
          )
        },
        onError: reject,
      },
    )
  })
}
