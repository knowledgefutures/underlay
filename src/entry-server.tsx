import { PassThrough, } from 'node:stream'
import { renderToPipeableStream, } from 'react-dom/server'
import { StaticRouter, } from 'react-router'
import App, { routes, } from '~/App'
import { SSRDataProvider, } from '~/lib/ssr-data'
import { runLoaders, } from '~/loaders.server'

function matchPath(pattern: string, pathname: string,): Record<string, string> | null {
  const patternParts = pattern.split('/',).filter(Boolean,)
  const pathParts = pathname.split('/',).filter(Boolean,)

  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const pat = patternParts[i]!
    const val = pathParts[i]!
    if (pat.startsWith(':',)) {
      params[pat.slice(1,)] = val
    } else if (pat !== val) {
      return null
    }
  }
  return params
}

function matchRoutes(url: string,) {
  const pathname = new URL(url, 'http://localhost',).pathname
  const matched: { path: string; params: Record<string, string> }[] = []

  for (const route of routes) {
    const params = matchPath(route.path, pathname,)
    if (params !== null) {
      matched.push({ path: route.path, params, },)
      break // first match wins
    }
  }
  return matched
}

export async function render(
  request: Request,
): Promise<{
  html: string
  ssrData: Record<string, unknown>
  redirect?: string
  statusCode?: number
  title?: string
  description?: string
}> {
  const url = request.url
  const pathname = new URL(url, 'http://localhost',).pathname
  const matchedRoutes = matchRoutes(url,)

  let ssrData: Record<string, unknown>
  let redirect: string | undefined
  let statusCode: number | undefined
  let title: string | undefined
  let description: string | undefined

  try {
    const result = await runLoaders(matchedRoutes, request,)
    ssrData = result.data
    redirect = result.redirect
    statusCode = result.statusCode
    title = result.title
    description = result.description
  } catch (err) {
    console.error('Loader error:', err,)
    ssrData = {}
    statusCode = 500
  }

  if (redirect) {
    return { html: '', ssrData: {}, redirect, statusCode: statusCode ?? 302, }
  }

  return new Promise((resolve, reject,) => {
    let html = ''
    const passthrough = new PassThrough()
    passthrough.on('data', (chunk,) => {
      html += chunk.toString()
    },)

    const { pipe, } = renderToPipeableStream(
      <StaticRouter location={pathname}>
        <SSRDataProvider data={ssrData}>
          <App />
        </SSRDataProvider>
      </StaticRouter>,
      {
        onAllReady() {
          pipe(passthrough,)
          passthrough.on(
            'end',
            () =>
              resolve({
                html,
                ssrData,
                ...(statusCode !== undefined && { statusCode, }),
                ...(title !== undefined && { title, }),
                ...(description !== undefined && { description, }),
              },),
          )
        },
        onError: reject,
      },
    )
  },)
}
