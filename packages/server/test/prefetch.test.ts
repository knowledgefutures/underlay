import { afterEach, describe, expect, it, vi } from 'vitest'

import { prefetchGet, takePrefetched } from '../../web/src/lib/prefetch.js'

afterEach(() => vi.restoreAllMocks())

describe("the web app's prefetch on intent", () => {
  it('holds what a prefetch fetched for one navigation, briefly', async () => {
    let n = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`body ${++n}`))
    const url = 'https://ul.test/api/collections/org/c'
    expect(takePrefetched(url)).toBe(null)
    // The prefetching loader reads its own response; the navigation gets an unread copy.
    expect(await (await prefetchGet(url, {})).text()).toBe('body 1')
    expect(await (await takePrefetched(url))!.text()).toBe('body 1')
    // Once only: the next load asks again.
    expect(takePrefetched(url)).toBe(null)
    // Not after the hold.
    await prefetchGet(url, {})
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11_000)
    expect(takePrefetched(url)).toBe(null)
  })

  it('holds nothing that failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('no', { status: 500 }),
    )
    const url = 'https://ul.test/api/collections/org/gone'
    await prefetchGet(url, {})
    expect(takePrefetched(url)).toBe(null)
  })
})
