import { describe, expect, test } from 'vitest'

import { buildRoutes } from '~/route-gen'

describe('buildRoutes', () => {
  test('converts index files to root path', () => {
    const routes = buildRoutes({
      './routes/index.tsx': () => Promise.resolve({}),
    })
    expect(routes).toEqual([{ path: '/', filePath: './routes/index.tsx' }])
  })

  test('converts static page files', () => {
    const routes = buildRoutes({
      './routes/about.tsx': () => Promise.resolve({}),
    })
    expect(routes).toEqual([{ path: '/about', filePath: './routes/about.tsx' }])
  })

  test('converts dynamic [param] segments to :param', () => {
    const routes = buildRoutes({
      './routes/blog/[slug].tsx': () => Promise.resolve({}),
    })
    expect(routes).toEqual([{ path: '/blog/:slug', filePath: './routes/blog/[slug].tsx' }])
  })

  test('converts nested index files', () => {
    const routes = buildRoutes({
      './routes/blog/index.tsx': () => Promise.resolve({}),
    })
    expect(routes).toEqual([{ path: '/blog', filePath: './routes/blog/index.tsx' }])
  })

  test('sorts static segments before dynamic ones', () => {
    const routes = buildRoutes({
      './routes/[owner]/index.tsx': () => Promise.resolve({}),
      './routes/blog/index.tsx': () => Promise.resolve({}),
      './routes/index.tsx': () => Promise.resolve({}),
    })
    const paths = routes.map((r) => r.path)
    expect(paths).toEqual(['/', '/blog', '/:owner'])
  })

  test('handles multi-level dynamic routes', () => {
    const routes = buildRoutes({
      './routes/[owner]/[collection]/index.tsx': () => Promise.resolve({}),
      './routes/blog/[slug].tsx': () => Promise.resolve({}),
      './routes/dashboard.tsx': () => Promise.resolve({}),
    })
    const paths = routes.map((r) => r.path)
    // static segments sort alphabetically, then dynamic segments come after
    expect(paths.indexOf('/blog/:slug')).toBeLessThan(paths.indexOf('/:owner/:collection'))
    expect(paths.indexOf('/dashboard')).toBeLessThan(paths.indexOf('/:owner/:collection'))
  })
})
