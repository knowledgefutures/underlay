import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { API_BODY_LIMIT, BODY_LIMITS, limitBody } from './body-limit.server.js'

function makeApp(maxSize: number) {
  const app = new Hono()
  app.post('/', limitBody(maxSize), async (c) => c.json({ length: (await c.req.text()).length }))
  return app
}

describe('limitBody', () => {
  it('passes bodies within the limit', async () => {
    const res = await makeApp(10).request('/', { method: 'POST', body: '0123456789' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ length: 10 })
  })

  it('answers 413 in the API error shape when Content-Length is over the limit', async () => {
    const res = await makeApp(10).request('/', { method: 'POST', body: '01234567890' })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: 'Request body exceeds the limit of 10 bytes',
      statusCode: 413,
    })
  })

  it('rejects chunked bodies that have no Content-Length once they pass the limit', async () => {
    const chunk = new TextEncoder().encode('0123456')
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      },
    })
    const res = await makeApp(10).request('/', {
      method: 'POST',
      body,
      headers: { 'Transfer-Encoding': 'chunked' },
      // @ts-expect-error duplex is required for stream bodies in Node
      duplex: 'half',
    })
    expect(res.status).toBe(413)
  })

  it('keeps the global limit above every per-route limit', () => {
    for (const limit of Object.values(BODY_LIMITS)) expect(API_BODY_LIMIT).toBeGreaterThan(limit)
  })
})
