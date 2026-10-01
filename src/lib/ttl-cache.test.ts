import { describe, expect, it } from 'vitest'

import { createTtlCache } from './ttl-cache.js'

describe('createTtlCache', () => {
  it('returns a value until the TTL elapses', () => {
    let t = 0
    const c = createTtlCache<string>(1000, 10, () => t)
    c.set('a', 'x')
    t = 999
    expect(c.get('a')).toBe('x')
    t = 1000
    expect(c.get('a')).toBeUndefined()
  })

  it('delete removes an entry', () => {
    const c = createTtlCache<number>(1000)
    c.set('a', 1)
    c.delete('a')
    expect(c.get('a')).toBeUndefined()
  })

  it('stays bounded, evicting expired then oldest entries', () => {
    let t = 0
    const c = createTtlCache<number>(100, 2, () => t)
    c.set('a', 1)
    t = 50
    c.set('b', 2)
    t = 120 // a expired
    c.set('c', 3)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    t = 121
    c.set('d', 4) // full, nothing expired -> evicts oldest (b)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
    expect(c.get('d')).toBe(4)
  })
})
