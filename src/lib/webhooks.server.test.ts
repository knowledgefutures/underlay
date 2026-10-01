import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it, vi } from 'vitest'

import {
  createCheckedLookup,
  createPinnedAgent,
  isPrivateIp,
  signPayload,
  validateWebhookUrl,
  webhookFetch,
} from './webhooks.server.js'

describe('signPayload', () => {
  it('produces a deterministic signature for a known input', () => {
    const sig = signPayload('secret', 'hello')
    // Reference HMAC-SHA256("secret", "hello")
    expect(sig).toBe('sha256=88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b')
    // Stable across calls
    expect(signPayload('secret', 'hello')).toBe(sig)
  })

  it('prefixes the hex digest with sha256=', () => {
    const sig = signPayload('secret', 'hello')
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('yields a different signature for a different secret', () => {
    expect(signPayload('secret-a', 'hello')).not.toBe(signPayload('secret-b', 'hello'))
  })

  it('yields a different signature for a different body', () => {
    expect(signPayload('secret', 'hello')).not.toBe(signPayload('secret', 'world'))
  })
})

describe('isPrivateIp', () => {
  it('flags loopback addresses', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('127.9.9.9')).toBe(true)
    expect(isPrivateIp('::1')).toBe(true)
  })

  it('flags private IPv4 ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true)
    expect(isPrivateIp('10.255.255.255')).toBe(true)
    expect(isPrivateIp('172.16.0.1')).toBe(true)
    expect(isPrivateIp('172.31.255.255')).toBe(true)
    expect(isPrivateIp('192.168.0.1')).toBe(true)
    expect(isPrivateIp('192.168.1.100')).toBe(true)
  })

  it('does not flag public IPv4 addresses just outside the private ranges', () => {
    expect(isPrivateIp('172.15.0.1')).toBe(false)
    expect(isPrivateIp('172.32.0.1')).toBe(false)
    expect(isPrivateIp('192.169.0.1')).toBe(false)
    expect(isPrivateIp('11.0.0.1')).toBe(false)
  })

  it('flags link-local addresses including the cloud metadata endpoint', () => {
    expect(isPrivateIp('169.254.0.1')).toBe(true)
    expect(isPrivateIp('169.254.169.254')).toBe(true)
  })

  it('flags IPv6 unique-local (fc00::/7)', () => {
    expect(isPrivateIp('fc00::1')).toBe(true)
    expect(isPrivateIp('fd12:3456:789a::1')).toBe(true)
    expect(isPrivateIp('fe80::1')).toBe(true) // link-local
  })

  it('flags IPv4-mapped IPv6 pointing at a private address', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true)
  })

  it('does not flag normal public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('1.1.1.1')).toBe(false)
    expect(isPrivateIp('93.184.216.34')).toBe(false)
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false)
  })

  it('flags carrier-grade NAT and the benchmarking range 198.18.0.0/15', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true)
    expect(isPrivateIp('100.127.255.255')).toBe(true)
    expect(isPrivateIp('198.18.0.1')).toBe(true)
    expect(isPrivateIp('198.19.255.255')).toBe(true)
    expect(isPrivateIp('198.17.255.255')).toBe(false)
    expect(isPrivateIp('198.20.0.1')).toBe(false)
  })

  it('flags IPv4 multicast (224/4) and reserved (240/4) space', () => {
    expect(isPrivateIp('223.255.255.255')).toBe(false)
    expect(isPrivateIp('224.0.0.1')).toBe(true)
    expect(isPrivateIp('239.255.255.255')).toBe(true)
    expect(isPrivateIp('240.0.0.1')).toBe(true)
    expect(isPrivateIp('255.255.255.255')).toBe(true)
  })

  it('flags IPv6 multicast (ff00::/8) and NAT64 (64:ff9b::/96)', () => {
    expect(isPrivateIp('ff02::1')).toBe(true)
    expect(isPrivateIp('ff00::')).toBe(true)
    expect(isPrivateIp('64:ff9b::7f00:1')).toBe(true)
    expect(isPrivateIp('64:ff9b::8.8.8.8')).toBe(true)
    expect(isPrivateIp('64:ff9a::1')).toBe(false)
    expect(isPrivateIp('64:ff9b:1::1')).toBe(false)
  })

  it('flags IPv4-mapped addresses written in hex or expanded form', () => {
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true)
    expect(isPrivateIp('::ffff:a9fe:a9fe')).toBe(true) // 169.254.169.254
    expect(isPrivateIp('0:0:0:0:0:ffff:7f00:1')).toBe(true)
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false)
    expect(isPrivateIp('::ffff:808:808')).toBe(false)
  })

  it('flags unspecified addresses', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true)
    expect(isPrivateIp('::')).toBe(true)
    expect(isPrivateIp('0:0:0:0:0:0:0:1')).toBe(true)
  })
})

describe('createCheckedLookup', () => {
  const lookupOf = (addresses: { address: string; family: number }[]) =>
    createCheckedLookup(() => Promise.resolve(addresses))
  const run = (
    lookup: ReturnType<typeof createCheckedLookup>,
    options: { all?: boolean } = {},
  ): Promise<{ err: Error | null; address?: unknown; family?: number | undefined }> =>
    new Promise((resolve) =>
      lookup('hook.example.org', options, (err, address, family) =>
        resolve({ err, address, family }),
      ),
    )

  it('returns the checked addresses for a public host', async () => {
    const addrs = [{ address: '93.184.216.34', family: 4 }]
    expect(await run(lookupOf(addrs), { all: true })).toMatchObject({ err: null, address: addrs })
    expect(await run(lookupOf(addrs))).toEqual({ err: null, address: '93.184.216.34', family: 4 })
  })

  it('fails when the host resolves to a private address', async () => {
    const { err } = await run(lookupOf([{ address: '10.0.0.5', family: 4 }]), { all: true })
    expect(err?.message).toMatch(/private address/)
  })

  it('fails when any one of several addresses is private', async () => {
    const { err } = await run(
      lookupOf([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
      { all: true },
    )
    expect(err?.message).toMatch(/private address/)
  })

  it('fails on an empty answer and on resolver errors', async () => {
    expect((await run(lookupOf([]))).err).toBeInstanceOf(Error)
    const boom = createCheckedLookup(() => Promise.reject(new Error('ENOTFOUND')))
    expect((await run(boom)).err?.message).toBe('ENOTFOUND')
  })
})

describe('webhookFetch', () => {
  const listen = () =>
    new Promise<{ server: http.Server; port: number; hits: string[] }>((resolve) => {
      const hits: string[] = []
      const server = http.createServer((req, res) => {
        hits.push(String(req.headers.host))
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/ok' }).end()
        } else {
          res.writeHead(204).end()
        }
      })
      server.listen(0, '127.0.0.1', () =>
        resolve({ server, port: (server.address() as AddressInfo).port, hits }),
      )
    })

  it('connects to the address the lookup returned, keeping the original Host header', async () => {
    const { server, port, hits } = await listen()
    // Loopback is normally blocked; disable the check so we can observe the pinning.
    const resolve = vi.fn(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }]))
    const agent = createPinnedAgent(createCheckedLookup(resolve, () => false))
    try {
      const res = await webhookFetch(
        `http://hook.example.test:${port}/ok`,
        { method: 'POST', body: '{}' },
        agent,
      )
      expect(res.status).toBe(204)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(hits).toEqual([`hook.example.test:${port}`])
    } finally {
      await agent.close()
      server.close()
    }
  })

  it('never connects when the hostname resolves to a private address', async () => {
    const { server, port, hits } = await listen()
    const agent = createPinnedAgent(
      createCheckedLookup(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }])),
    )
    try {
      const err = await webhookFetch(
        `http://rebind.example.test:${port}/ok`,
        { method: 'POST', body: '{}' },
        agent,
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).cause).toMatchObject({ name: 'BlockedAddressError' })
      expect(hits).toEqual([])
    } finally {
      await agent.close()
      server.close()
    }
  })

  it('rejects literal private IPs, including bracketed IPv6, without connecting', async () => {
    await expect(webhookFetch('http://127.0.0.1:9/', { method: 'POST' })).rejects.toThrow(
      /private address/,
    )
    await expect(webhookFetch('http://[::1]:9/', { method: 'POST' })).rejects.toThrow(
      /private address/,
    )
    await expect(webhookFetch('http://[64:ff9b::7f00:1]:9/', { method: 'POST' })).rejects.toThrow(
      /private address/,
    )
  })

  it('treats redirects as errors', async () => {
    const { server, port, hits } = await listen()
    const agent = createPinnedAgent(
      createCheckedLookup(
        () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        () => false,
      ),
    )
    try {
      await expect(
        webhookFetch(`http://hook.example.test:${port}/redirect`, { method: 'POST' }, agent),
      ).rejects.toThrow()
      expect(hits).toHaveLength(1) // the redirect target was never requested
    } finally {
      await agent.close()
      server.close()
    }
  })
})

describe('validateWebhookUrl', () => {
  it('accepts a normal https public URL', () => {
    const result = validateWebhookUrl('https://example.org/hooks/underlay')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url).toBe('https://example.org/hooks/underlay')
  })

  it('rejects http when insecure URLs are not allowed (production)', () => {
    const result = validateWebhookUrl('http://example.org/hook', { allowInsecure: false })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/https/)
  })

  it('allows http only when insecure URLs are permitted (non-production)', () => {
    expect(validateWebhookUrl('http://example.org/hook', { allowInsecure: true }).ok).toBe(true)
  })

  it('rejects localhost and internal hostnames', () => {
    expect(validateWebhookUrl('https://localhost/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://foo.localhost/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://svc.internal/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://db.local/hook').ok).toBe(false)
  })

  it('rejects literal private IP hosts', () => {
    expect(validateWebhookUrl('https://127.0.0.1/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://10.0.0.1/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false)
  })

  it('rejects bracketed private IPv6 literal hosts', () => {
    expect(validateWebhookUrl('https://[::1]/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://[fd00::1]/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://[::ffff:7f00:1]/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://[2606:4700:4700::1111]/hook').ok).toBe(true)
  })

  it('rejects malformed URLs', () => {
    expect(validateWebhookUrl('not a url').ok).toBe(false)
    expect(validateWebhookUrl('ftp://example.org/x').ok).toBe(false)
  })
})
