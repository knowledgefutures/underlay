import { PassThrough } from 'node:stream'

import { renderToPipeableStream } from 'react-dom/server'
import { StaticRouter } from 'react-router'

import App, { routes } from '~/App'
import { SSRDataProvider } from '~/lib/ssr-data'
import { runLoaders } from '~/loaders.server'
import { matchRoutes } from '~/route-gen'

type LoaderResult = {
  data: Record<string, unknown>
  redirect?: string
  statusCode?: number
  title?: string
  description?: string
}

export async function loadData(request: Request): Promise<LoaderResult> {
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

  const result = await loadData(request).catch((err: unknown) => {
    console.error('Loader error:', err)
    return { data: {}, statusCode: 500 } as LoaderResult
  })

  if (result.redirect) {
    return {
      html: '',
      ssrData: {},
      redirect: result.redirect,
      statusCode: result.statusCode ?? 302,
    }
  }

  return new Promise((resolve, reject) => {
    let html = ''
    const passthrough = new PassThrough()
    passthrough.on('data', (chunk) => {
      html += chunk.toString()
    })

    const { pipe } = renderToPipeableStream(
      <StaticRouter location={pathname}>
        <SSRDataProvider data={result.data}>
          <App />
        </SSRDataProvider>
      </StaticRouter>,
      {
        onAllReady() {
          pipe(passthrough)
          passthrough.on('end', () =>
            resolve({
              html,
              ssrData: result.data,
              ...(result.statusCode !== undefined && { statusCode: result.statusCode }),
              ...(result.title !== undefined && { title: result.title }),
              ...(result.description !== undefined && { description: result.description }),
            }),
          )
        },
        onError: reject,
      },
    )
  })
}
