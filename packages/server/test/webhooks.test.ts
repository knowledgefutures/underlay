import { createHmac } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { isPrivateIp, validateWebhookUrl } from '../src/webhooks/webhooks.js'
import { cleanup, harness, outboundCalls, respondOutbound } from './harness.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } } }

async function json(res: Response) {
  return (await res.json()) as any
}

describe('webhook URL checks', () => {
  it('refuses private and local targets', () => {
    for (const u of [
      'http://example.org',
      'https://localhost/x',
      'https://10.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/',
      'https://svc.internal/',
    ]) {
      expect(validateWebhookUrl(u, false).ok).toBe(false)
    }
    expect(validateWebhookUrl('https://hooks.example.org/underlay', false).ok).toBe(true)
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true)
    expect(isPrivateIp('8.8.8.8')).toBe(false)
  })
})

describe('webhooks', () => {
  it('delivers signed version.created events after a push, and retries failures', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('hooked')
    const base = '/api/collections/org/hooked'
    let res = await h.request(`${base}/webhooks`, {
      method: 'POST',
      user,
      json: { url: 'https://hooks.example.org/u', bumpFilter: ['major', 'minor'] },
    })
    expect(res.status).toBe(201)
    const hook = await json(res)
    expect(hook.secret).toMatch(/^ulwhsec_/)
    const listed = await json(await h.request(`${base}/webhooks`, { user }))
    expect(listed.webhooks[0]).not.toHaveProperty('secret')

    outboundCalls.length = 0
    let fail = true
    respondOutbound(() => (fail ? new Response('nope', { status: 500 }) : new Response('ok')))

    const sid = (
      await json(
        await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
      )
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [{ id: 'a', type: 'Author', data: { name: 'A' } }],
    })
    expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      201,
    )
    await h.drain()
    expect(outboundCalls.length).toBe(1)
    const call = outboundCalls[0]!
    const body = String(call.init.body)
    const headers = call.init.headers as Record<string, string>
    expect(headers['x-underlay-signature']).toBe(
      `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}`,
    )
    expect(JSON.parse(body)).toMatchObject({
      event: 'version.created',
      collection: { owner: 'org', slug: 'hooked' },
      version: { semver: 'v1.0.0' },
      bumpType: 'major',
    })

    // The failure was recorded and a retry queued with a delay.
    let deliveries = (
      await json(await h.request(`${base}/webhooks/${hook.id}/deliveries`, { user }))
    ).deliveries
    expect(deliveries[0]).toMatchObject({ status: 'failed', attempts: 1, responseCode: 500 })
    fail = false
    await h.ports.db.update(schema.jobs).set({ runAt: new Date(0) })
    await h.drain()
    deliveries = (await json(await h.request(`${base}/webhooks/${hook.id}/deliveries`, { user })))
      .deliveries
    expect(deliveries[0]).toMatchObject({ status: 'success', attempts: 2 })

    // A patch bump doesn't match the filter.
    const meta = (
      await json(
        await h.request(`${base}/push`, {
          method: 'POST',
          user,
          json: { base: 'v1.0.0', metadata_patch: { title: 'x' } },
        }),
      )
    ).session_id
    expect((await h.request(`${base}/push/${meta}/commit`, { method: 'POST', user })).status).toBe(
      201,
    )
    outboundCalls.length = 0
    await h.drain()
    expect(outboundCalls.length).toBe(0)
  })

  it('is for org owners and admins only', async () => {
    const h = await harness()
    await h.member('owner1')
    await h.collection('hooked')
    await h.ports.db.insert(schema.user).values({ id: 'm2', name: 'm', email: 'm2@example.org' })
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'org1', userId: 'm2', role: 'member' })
    expect((await h.request('/api/collections/org/hooked/webhooks', { user: 'm2' })).status).toBe(
      403,
    )
    expect(
      (await h.request('/api/collections/org/hooked/webhooks', { user: 'owner1' })).status,
    ).toBe(200)
  })
})
