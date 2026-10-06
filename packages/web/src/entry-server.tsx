/**
 * Server rendering for the v2 app: `renderPage` is what @underlay/server's
 * `Setup.renderPage` calls for every non-/api GET.
 *
 * Runtime-neutral: Web Streams (renderToReadableStream) and no filesystem, so
 * the same bundle runs on Workers (with nodejs_compat, for AsyncLocalStorage)
 * and on Node 24. The HTML template and the client asset list are inlined at
 * build time (vite.config.ts), since a Worker can't read dist/ at run time.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { renderToReadableStream } from 'react-dom/server'
import {
  createStaticHandler,
  createStaticRouter,
  isRouteErrorResponse,
  type StaticHandlerContext,
  StaticRouterProvider,
} from 'react-router'
import { assetTags } from 'virtual:underlay/client-assets'

import { routes } from '~/App'
import { type ApiFn, setSsrApiResolver } from '~/lib/fetch-base'
import { escapeHtml } from '~/lib/markdown'

import template from '../index.html?raw'

/** Structurally the same as RenderPage in @underlay/server's app.ts. */
export type RenderPage = (req: Request, api: ApiFn) => Promise<Response>

// Each render's in-process API, found by loaders through apiFetch. Concurrent
// renders on one isolate or process each see their own.
const apiStore = new AsyncLocalStorage<ApiFn>()
setSsrApiResolver(() => apiStore.getStore())

const handler = createStaticHandler(routes, { future: { v8_middleware: true } })

// index.html loads the source entry and stylesheet for a Vite dev server; a
// built page gets the hashed assets from the client manifest instead.
const DEV_STYLESHEET = '<link rel="stylesheet" href="/src/global.css" />'
const DEV_SCRIPT = '<script type="module" src="/src/entry-client.tsx"></script>'
const page = template
  .replace(DEV_STYLESHEET, () => assetTags.head)
  .replace(DEV_SCRIPT, () => assetTags.body)

/**
 * Substitute a placeholder in the HTML template with untrusted content.
 *
 * `String.prototype.replace` with a *string* replacement treats `$` sequences
 * specially (`$&`, `` $` ``, `$'`, `$$`), so a README containing `` $` `` would
 * splice the template prefix into the body. A replacement function is inserted
 * verbatim.
 */
function fill(html: string, placeholder: string, content: string): string {
  return html.replace(placeholder, () => content)
}

/**
 * Loader redirects are built from route params, which React Router decodes, so
 * `/%2Fevil.com/x/diff` would yield `Location: //evil.com/...`. Every legitimate
 * loader redirect is a local path, so anything else goes home.
 */
function localRedirect(location: string): string {
  return location.startsWith('/') && !/^\/[/\\]/.test(location) ? location : '/'
}

/**
 * Route errors in the form createBrowserRouter revives on hydration (what
 * StaticRouterProvider's own hydration script writes): a thrown 404 Response
 * must come back as a RouteErrorResponse, or the client renders a different
 * error boundary than the server did.
 */
function serializeErrors(errors: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!errors) return null
  const out: Record<string, unknown> = {}
  for (const [id, err] of Object.entries(errors)) {
    if (isRouteErrorResponse(err)) out[id] = { ...err, __type: 'RouteErrorResponse' }
    else if (err instanceof Error) {
      out[id] = {
        message: err.message,
        __type: 'Error',
        ...(err.name !== 'Error' && { __subType: err.name }),
      }
    } else out[id] = err
  }
  return out
}

type Meta = string | ((params: Record<string, string>, data: unknown) => string)

/** Title and description from the deepest matched routes' handles. */
function pageMeta(context: StaticHandlerContext): { title?: string; description?: string } {
  let title: string | undefined
  let description: string | undefined
  for (let i = context.matches.length - 1; i >= 0; i--) {
    const match = context.matches[i]!
    const handle = match.route.handle as { title?: Meta; description?: Meta } | undefined
    const resolve = (m: Meta) =>
      typeof m === 'function'
        ? m(match.params as Record<string, string>, context.loaderData[match.route.id])
        : m
    if (handle?.title && title === undefined) title = resolve(handle.title)
    if (handle?.description && description === undefined) description = resolve(handle.description)
    if (title !== undefined && description !== undefined) break
  }
  return {
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
  }
}

async function render(req: Request): Promise<Response> {
  // With generateMiddlewareResponse, route middleware (requireAuth) runs around
  // the loaders; without it the static handler skips middleware entirely.
  const result = await handler.query(req, {
    generateMiddlewareResponse: async (query) => {
      const context = await query(req)
      return context instanceof Response ? context : renderContext(context)
    },
  })
  // Always a Response once generateMiddlewareResponse is given; the declared
  // type still includes the context.
  const res = result instanceof Response ? result : await renderContext(result)
  // A loader or middleware redirect.
  const location = res.headers.get('Location')
  if (location && res.status >= 300 && res.status < 400) {
    return new Response(null, {
      status: res.status,
      headers: { Location: localRedirect(location) },
    })
  }
  return res
}

async function renderContext(context: StaticHandlerContext): Promise<Response> {
  const { title, description } = pageMeta(context)
  const router = createStaticRouter(handler.dataRoutes, context)

  let renderError: unknown = null
  const stream = await renderToReadableStream(
    <StaticRouterProvider router={router} context={context} hydrate={false} />,
    {
      onError(err) {
        renderError = err
      },
    },
  )
  // As v1 did with onAllReady: the whole page (lazy route components included)
  // before the first byte, so the HTML is complete for crawlers and status codes hold.
  await stream.allReady
  if (renderError) throw renderError
  const html = await new Response(stream).text()

  const hydrationData = JSON.stringify({
    loaderData: context.loaderData,
    actionData: context.actionData ?? null,
    errors: serializeErrors(context.errors),
  }).replace(/</g, '\\u003c')

  let out = fill(page, '<!--ssr-outlet-->', html)
  out = fill(
    out,
    '<!--ssr-data-->',
    `<script>window.__staticRouterHydrationData=${hydrationData}</script>`,
  )
  if (title) out = fill(out, '<title>Underlay</title>', `<title>${escapeHtml(title)}</title>`)
  if (description) {
    out = fill(
      out,
      '</head>',
      `<meta name="description" content="${escapeHtml(description)}" />\n</head>`,
    )
  }

  return new Response(out, {
    status: context.statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export const renderPage: RenderPage = (req, api) => apiStore.run(api, () => render(req))
