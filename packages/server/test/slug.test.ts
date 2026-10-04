import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  defaultOrgSlugCandidate,
  RESERVED_COLLECTION_SLUGS,
  RESERVED_ORG_SLUGS,
  validateCollectionSlug,
  validateOrgSlug,
} from '../src/lib/slug.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

describe('top-level paths', () => {
  it('are reserved org slugs, so no org page is shadowed', async () => {
    const routes = join(import.meta.dirname, '../../web/src/routes')
    const segments = async (dir: string) => {
      const out = new Set<string>()
      for (const name of await readdir(dir)) {
        const seg = name.replace(/\.(data\.)?tsx?$/, '')
        if (!seg.startsWith('[') && seg !== 'index') out.add(seg)
      }
      return out
    }
    const top = await segments(routes)
    expect(top.size).toBeGreaterThan(10)
    for (const seg of top) expect(RESERVED_ORG_SLUGS, seg).toContain(seg)
    // An org's own pages, likewise for collection slugs.
    for (const seg of await segments(join(routes, '[owner]')))
      expect(RESERVED_COLLECTION_SLUGS, seg).toContain(seg)
    expect(validateOrgSlug('protocol')).toBe('That slug is reserved')
    expect(validateOrgSlug('billing')).toBe('That slug is reserved')
    // Collections may use words only orgs can't: arxiv/search is fine, org/settings isn't.
    expect(validateCollectionSlug('search')).toBeNull()
    expect(validateCollectionSlug('settings')).toBe('That slug is reserved')
  })

  it('give personal orgs a free slug when the email names a reserved word', () => {
    expect(defaultOrgSlugCandidate('ada@example.org')).toBe('ada')
    expect(defaultOrgSlugCandidate('ada@example.org', 2)).toBe('ada-2')
    expect(defaultOrgSlugCandidate('support@example.org')).toBe('support-1')
    expect(defaultOrgSlugCandidate('support@example.org', 1)).toBe('support-2')
    expect(defaultOrgSlugCandidate('a@example.org')).toBe('a-1')
    for (const e of ['admin@x.org', 'user@x.org', '@x.org'])
      expect(validateOrgSlug(defaultOrgSlugCandidate(e))).toBeNull()
  })

  it('redirect old blog and protocol URLs', async () => {
    const h = await harness()
    let res = await h.request('/blog/hello-World')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://www.knowledgefutures.org/updates/hello-world')
    res = await h.request('/blog')
    expect(res.headers.get('location')).toBe('https://www.knowledgefutures.org/?tag=underlay')
    res = await h.request('/protocol')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/docs/protocol')
  })
})
