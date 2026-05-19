import type { MiddlewareHandler } from 'hono'

import { buildErc, DEFAULT_NAAN } from '../lib/ark.js'

/**
 * Hono middleware that intercepts /ark:NAAN/... URLs and resolves them.
 * In the new single-server architecture, we call the API route handler internally
 * via a local fetch to localhost (same process).
 */
export const arkMiddleware: MiddlewareHandler = async (c, _next) => {
  const url = new URL(c.req.url)
  const pathname = url.pathname
  const search = url.search

  if (!pathname.startsWith('/ark:')) {
    return _next()
  }

  const fullPath = pathname.slice(1) // strip leading /

  // Check if this is a root NAAN path
  const afterLabel = fullPath.slice(4) // strip "ark:"
  const slashIdx = afterLabel.indexOf('/')
  const naan = slashIdx === -1 ? afterLabel : afterLabel.slice(0, slashIdx)
  const afterNaan = slashIdx === -1 ? '' : afterLabel.slice(slashIdx + 1)

  if (!afterNaan.trim()) {
    return new Response(
      [
        `The Underlay assigns identifiers within the ARK domain ${naan} with the following principles:`,
        '',
        '1. Persistence: ARKs are never reassigned. Once minted, an ARK will always resolve to the same collection or record, or return a tombstone response if the object has been deleted.',
        '',
        '2. Transparency: Appending ?info or ?? to any ARK returns an Electronic Resource Citation (ERC) describing the identified object.',
        '',
        '3. Openness: ARKs are free, open identifiers requiring no licensing fees. The Underlay uses the ARK scheme as specified by the ARK Alliance.',
        '',
        '4. Scope: Underlay ARKs primarily identify versioned data collections and the records within them. Collection ARKs redirect to the collection overview; version-qualified ARKs redirect to specific version pages; record ARKs redirect to the canonical URL of the identified record.',
        '',
        `For more information, see: https://underlay.org/ark:${naan}/`,
      ].join('\n'),
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    )
  }

  // Resolve the ARK via internal API
  const port = Number(process.env.PORT) || 3000
  const apiBase = `http://localhost:${port}`
  const params = new URLSearchParams({ path: fullPath })
  let resolveRes: Response
  try {
    resolveRes = await fetch(`${apiBase}/api/ark/resolve?${params}`)
  } catch {
    return new Response('ARK resolver unavailable', { status: 503 })
  }

  if (!resolveRes.ok) {
    const body = await resolveRes.json().catch(() => ({}))
    if (body?.type === 'not_found') {
      return new Response('ARK not found', { status: 404 })
    }
    return new Response('ARK resolution error', { status: 502 })
  }

  const data = await resolveRes.json()

  if (data.type === 'not_found') {
    return new Response('ARK not found', { status: 404 })
  }

  const { metadata } = data
  const resolvedNaan = metadata?.naan ?? DEFAULT_NAAN

  // Handle inflections
  if (search === '?info' || search === '??' || search === '%3F%3F') {
    const erc = buildErc({
      type: metadata.type,
      who: metadata.who ?? metadata.ownerName ?? '(:unkn)',
      what: metadata.what ?? metadata.collectionName ?? '(:unkn)',
      when: metadata.when ?? '(:unkn)',
      where: metadata.where ?? metadata.arkUrl ?? '(:unkn)',
      naan: resolvedNaan,
    })
    return new Response(erc, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  if (search === '?json') {
    return new Response(JSON.stringify(metadata, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Regular resolution — redirect
  const targetUrl = data.url
  const redirectTarget = targetUrl.startsWith('/') ? `${url.origin}${targetUrl}` : targetUrl

  return c.redirect(redirectTarget, 302)
}
