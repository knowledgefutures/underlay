import { describe, expect, it } from 'vitest'

import { canonicalize, hashRecord, hashSchema } from './hash.js'

describe('canonicalize', () => {
  it('sorts object keys recursively', () => {
    expect(JSON.stringify(canonicalize({ b: 1, a: { d: 2, c: 3 } }))).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    )
  })

  it('preserves array order but canonicalizes elements', () => {
    expect(JSON.stringify(canonicalize([{ b: 1, a: 2 }, 3, 'x']))).toBe('[{"a":2,"b":1},3,"x"]')
  })

  it('passes through primitives and null', () => {
    expect(canonicalize(null)).toBe(null)
    expect(canonicalize(42)).toBe(42)
    expect(canonicalize('s')).toBe('s')
    expect(canonicalize(true)).toBe(true)
  })
})

describe('hashRecord', () => {
  // Golden value: locks the record wire format {"id":...,"type":...,"data":...}.
  // If this test fails, the protocol's record content-address has changed.
  it('matches the golden hash for a known record', () => {
    const { hash, canonical } = hashRecord({
      id: 'r1',
      type: 'Author',
      data: { name: 'Ada', year: 1815 },
    })
    expect(canonical).toBe('{"id":"r1","type":"Author","data":{"name":"Ada","year":1815}}')
    expect(hash).toBe('adefbd10aa438f0c6ed1627817f391ac6cc0441737ee09b4ebcc30fbd8386c63')
  })

  it('is insensitive to data key order', () => {
    const a = hashRecord({ id: 'r1', type: 'Author', data: { name: 'Ada', year: 1815 } })
    const b = hashRecord({ id: 'r1', type: 'Author', data: { year: 1815, name: 'Ada' } })
    expect(a.hash).toBe(b.hash)
  })

  it('changes when id, type, or data changes', () => {
    const base = hashRecord({ id: 'r1', type: 'Author', data: { name: 'Ada' } }).hash
    expect(hashRecord({ id: 'r2', type: 'Author', data: { name: 'Ada' } }).hash).not.toBe(base)
    expect(hashRecord({ id: 'r1', type: 'Pub', data: { name: 'Ada' } }).hash).not.toBe(base)
    expect(hashRecord({ id: 'r1', type: 'Author', data: { name: 'Eda' } }).hash).not.toBe(base)
  })
})

describe('hashSchema', () => {
  it('matches the golden hash for a known schema', () => {
    expect(hashSchema({ type: 'object', properties: { name: { type: 'string' } } })).toBe(
      '2b7196d853bac7cea83330be9c2073848dedc10746eaf403bb5f73687531baf2',
    )
  })

  it('is insensitive to key order (alignment property)', () => {
    expect(hashSchema({ type: 'object', properties: { name: { type: 'string' } } })).toBe(
      hashSchema({ properties: { name: { type: 'string' } }, type: 'object' }),
    )
  })
})
