import { describe, expect, it } from 'vitest'

import { isPrivateIp, signPayload, validateWebhookUrl } from './webhooks.server.js'

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

  it('rejects malformed URLs', () => {
    expect(validateWebhookUrl('not a url').ok).toBe(false)
    expect(validateWebhookUrl('ftp://example.org/x').ok).toBe(false)
  })
})
