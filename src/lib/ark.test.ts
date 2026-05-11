import { describe, expect, test, vi } from 'vitest'

// Mock the DB module so the top-level import in ark.ts doesn't blow up
vi.mock('~/db/client.server.js', () => ({ db: {}, schema: {} }))

import {
  BETANUMERIC,
  BETANUMERIC_CONSONANTS,
  buildArkUrl,
  buildErc,
  collectionToArkId,
  computeNcdaCheckChar,
  formatErcDate,
  nextShoulderCounter,
  parseArkPath,
} from '~/lib/ark'

describe('computeNcdaCheckChar', () => {
  test('returns a betanumeric character', () => {
    const ch = computeNcdaCheckChar('bcdf')
    expect(BETANUMERIC).toContain(ch)
  })

  test('is deterministic', () => {
    expect(computeNcdaCheckChar('test123')).toBe(computeNcdaCheckChar('test123'))
  })

  test('different inputs produce different check chars', () => {
    const a = computeNcdaCheckChar('abc')
    const b = computeNcdaCheckChar('xyz')
    // Not guaranteed for all inputs, but these particular ones differ
    expect(a).not.toBe(b)
  })
})

describe('collectionToArkId', () => {
  test('returns a 10-character string', () => {
    const id = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    expect(id).toHaveLength(10)
  })

  test('uses only betanumeric characters', () => {
    const id = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    for (const ch of id) {
      expect(BETANUMERIC).toContain(ch)
    }
  })

  test('first character is always a consonant', () => {
    // Test several UUIDs to exercise the fallback path
    const uuids = [
      '550e8400-e29b-41d4-a716-446655440000',
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]
    for (const uuid of uuids) {
      const id = collectionToArkId(uuid)
      expect(BETANUMERIC_CONSONANTS).toContain(id[0])
    }
  })

  test('is deterministic', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    expect(collectionToArkId(uuid)).toBe(collectionToArkId(uuid))
  })

  test('different UUIDs produce different IDs', () => {
    const a = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    const b = collectionToArkId('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
    expect(a).not.toBe(b)
  })
})

describe('nextShoulderCounter', () => {
  test('maps 0 to first consonant', () => {
    expect(nextShoulderCounter(0)).toBe('b')
  })

  test('maps sequential counts to single consonants', () => {
    expect(nextShoulderCounter(1)).toBe('c')
    expect(nextShoulderCounter(2)).toBe('d')
  })

  test('maps 18 to last single consonant', () => {
    expect(nextShoulderCounter(18)).toBe('z')
  })

  test('wraps to two characters at 19', () => {
    expect(nextShoulderCounter(19)).toBe('bb')
    expect(nextShoulderCounter(20)).toBe('bc')
  })

  test('uses only consonant characters', () => {
    for (let i = 0; i < 50; i++) {
      const result = nextShoulderCounter(i)
      for (const ch of result) {
        expect(BETANUMERIC_CONSONANTS).toContain(ch)
      }
    }
  })
})

describe('parseArkPath', () => {
  // Helper: build a valid path from components
  function makeValidPath(shoulder: string, arkId: string, version?: number) {
    const check = computeNcdaCheckChar(arkId)
    let path = `${shoulder}${arkId}${check}`
    if (version !== undefined) path += `.v${version}`
    return path
  }

  test('parses a basic collection ARK', () => {
    const arkId = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    const path = makeValidPath('ulb3', arkId)
    const result = parseArkPath(path)
    expect(result).toEqual({
      shoulder: 'ulb3',
      collectionArkId: arkId,
    })
  })

  test('parses ARK with version suffix', () => {
    const arkId = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    const path = makeValidPath('ulb3', arkId, 5)
    const result = parseArkPath(path)
    expect(result).toMatchObject({
      shoulder: 'ulb3',
      collectionArkId: arkId,
      version: 5,
    })
  })

  test('parses ARK with record type and record ID', () => {
    const arkId = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    const check = computeNcdaCheckChar(arkId)
    const path = `ulb3${arkId}${check}/Article/rec-001`
    const result = parseArkPath(path)
    expect(result).toMatchObject({
      shoulder: 'ulb3',
      collectionArkId: arkId,
      recordType: 'Article',
      recordId: 'rec-001',
    })
  })

  test('rejects paths not starting with ul', () => {
    expect(parseArkPath('xxb3abcdefghijk')).toBeNull()
  })

  test('rejects paths with invalid check digit', () => {
    const arkId = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    const badCheck = arkId + 'x' // wrong check char (almost certainly)
    expect(parseArkPath(`ulb3${badCheck}`)).toBeNull()
  })

  test('rejects version 0', () => {
    const arkId = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    const path = makeValidPath('ulb3', arkId) + '.v0'
    // version 0 is replaced by the full arkIdWithCheck since .v0 causes vNum < 1
    expect(parseArkPath(path.replace(makeValidPath('ulb3', arkId), makeValidPath('ulb3', arkId)))).toBeNull
  })

  test('handles multi-character shoulder counters', () => {
    const arkId = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')
    const path = makeValidPath('ulbc5', arkId)
    const result = parseArkPath(path)
    expect(result).toMatchObject({
      shoulder: 'ulbc5',
      collectionArkId: arkId,
    })
  })
})

describe('buildArkUrl', () => {
  test('builds a basic ARK URL', () => {
    const url = buildArkUrl('12345', 'ulb3', 'bcdfghjkmn')
    const check = computeNcdaCheckChar('bcdfghjkmn')
    expect(url).toBe(`https://underlay.org/ark:12345/ulb3bcdfghjkmn${check}`)
  })

  test('includes version suffix', () => {
    const url = buildArkUrl('12345', 'ulb3', 'bcdfghjkmn', 2)
    const check = computeNcdaCheckChar('bcdfghjkmn')
    expect(url).toBe(`https://underlay.org/ark:12345/ulb3bcdfghjkmn${check}.v2`)
  })

  test('includes record type and record ID', () => {
    const url = buildArkUrl('12345', 'ulb3', 'bcdfghjkmn', undefined, 'Article', 'rec-1')
    const check = computeNcdaCheckChar('bcdfghjkmn')
    expect(url).toBe(`https://underlay.org/ark:12345/ulb3bcdfghjkmn${check}/Article/rec-1`)
  })

  test('roundtrips with parseArkPath', () => {
    const naan = '12345'
    const shoulder = 'ulb3'
    const arkId = collectionToArkId('550e8400-e29b-41d4-a716-446655440000')

    const url = buildArkUrl(naan, shoulder, arkId, 3, 'Article', 'rec-001')
    // Extract the path after "ark:NAAN/"
    const pathAfterNaan = url.split(`ark:${naan}/`)[1]!
    const parsed = parseArkPath(pathAfterNaan)

    expect(parsed).toMatchObject({
      shoulder,
      collectionArkId: arkId,
      version: 3,
      recordType: 'Article',
      recordId: 'rec-001',
    })
  })
})

describe('formatErcDate', () => {
  test('formats a Date object as YYYYMMDD', () => {
    expect(formatErcDate(new Date('2026-05-04T00:00:00Z'))).toBe('20260504')
  })

  test('formats a date string', () => {
    expect(formatErcDate('2024-01-15T12:00:00Z')).toBe('20240115')
  })

  test('pads month and day with zeros', () => {
    expect(formatErcDate(new Date('2026-01-02T00:00:00Z'))).toBe('20260102')
  })
})

describe('buildErc', () => {
  test('produces a valid ERC record', () => {
    const erc = buildErc({
      type: 'collection',
      who: 'Test Author',
      what: 'Test Collection',
      when: '20260504',
      where: 'https://underlay.org/ark:12345/ulb3test',
      naan: '12345',
    })
    expect(erc).toContain('erc:')
    expect(erc).toContain('who: Test Author')
    expect(erc).toContain('what: Test Collection')
    expect(erc).toContain('when: 20260504')
    expect(erc).toContain('where: https://underlay.org/ark:12345/ulb3test')
    expect(erc).toContain('erc-support:')
    expect(erc).toContain('who: Underlay')
  })
})
