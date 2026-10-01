import { describe, expect, it } from 'vitest'

import { dedupeByHash, tallyInserted } from './negotiate-counts.js'

describe('dedupeByHash', () => {
  it('keeps the first entry for each hash, in order', () => {
    const out = dedupeByHash([
      { hash: 'a', id: '1' },
      { hash: 'b', id: '2' },
      { hash: 'a', id: '3' },
    ])
    expect(out).toEqual([
      { hash: 'a', id: '1' },
      { hash: 'b', id: '2' },
    ])
  })

  it('returns an empty list for an empty manifest', () => {
    expect(dedupeByHash([])).toEqual([])
  })
})

describe('tallyInserted', () => {
  it('counts every inserted row as received and the needed ones as needed', () => {
    expect(tallyInserted([{ needed: true }, { needed: false }, { needed: true }])).toEqual({
      received: 3,
      needed: 2,
    })
  })

  it('adds nothing when the insert conflicted away entirely (a retried chunk)', () => {
    expect(tallyInserted([])).toEqual({ received: 0, needed: 0 })
  })
})
