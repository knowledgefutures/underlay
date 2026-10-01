import { describe, expect, it } from 'vitest'

import { createSingleFlight, ddlWithSamples } from './query-limits.js'

describe('createSingleFlight', () => {
  it('shares one run between concurrent callers with the same key', async () => {
    const once = createSingleFlight<number>()
    let runs = 0
    const run = async () => {
      runs++
      await new Promise((r) => setTimeout(r, 5))
      return runs
    }
    const [a, b] = await Promise.all([once('k', run), once('k', run)])
    expect(a).toBe(b)
    expect(runs).toBe(1)
    await once('other', run)
    expect(runs).toBe(2)
  })

  it('does not remember failures or completed runs', async () => {
    const once = createSingleFlight<string>()
    await expect(once('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await once('k', async () => 'ok')).toBe('ok')
    expect(await once('k', async () => 'again')).toBe('again')
  })
})

describe('ddlWithSamples', () => {
  const schemas = {
    Person: { type: 'object', properties: { name: { type: 'string' } } },
    Place: { type: 'object', properties: { label: { type: 'string' } } },
  }

  it('appends the sample row only to types that have one', () => {
    const out = ddlWithSamples(schemas, { Person: { name: 'Ada' } })
    expect(out).toContain('-- Example row: {"name":"Ada"}')
    expect(out.match(/-- Example row/g)).toHaveLength(1)
    expect(out).toContain('Person')
    expect(out).toContain('Place')
  })
})
