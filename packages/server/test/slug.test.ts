import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { RESERVED_SLUGS, validateSlug } from '../src/lib/slug.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

describe('top-level paths', () => {
  it('are reserved org slugs, so no org page is shadowed', async () => {
    const routes = join(import.meta.dirname, '../../web/src/routes')
    const top = new Set<string>()
    for (const name of await readdir(routes)) {
      const seg = name.replace(/\.(data\.)?tsx?$/, '')
      if (seg.startsWith('[') || seg === 'index') continue
      top.add(seg)
    }
    expect(top.size).toBeGreaterThan(10)
    for (const seg of top) expect(RESERVED_SLUGS, seg).toContain(seg)
    expect(validateSlug('protocol')).toBe('That slug is reserved')
  })

  it('send old blog URLs to the KF site', async () => {
    const h = await harness()
    let res = await h.request('/blog/hello-World')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://www.knowledgefutures.org/updates/hello-world')
    res = await h.request('/blog')
    expect(res.headers.get('location')).toBe('https://www.knowledgefutures.org/?tag=underlay')
  })
})
