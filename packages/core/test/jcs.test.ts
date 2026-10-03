import { describe, expect, it } from 'vitest'

import {
  hashRecord,
  hashSchema,
  hasArrayIndexKey,
  jcs,
  legacyRecordHash,
  legacySchemaHash,
} from '../src/index.js'

describe('jcs', () => {
  it('matches RFC 8785 §3.2.2 (primitives, numbers, escaping)', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    )
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    )
  })

  it('matches RFC 8785 §3.2.3 (key sorting by UTF-16 code units)', () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
        '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
        '"\\u00f6":"Latin Small Letter O With Diaeresis"}',
    )
    // Built from code points: the formatter turns \u escapes into literal
    // characters, and U+FB33 would not survive an NFC-normalizing editor.
    const k = (cp: number) => JSON.stringify(String.fromCodePoint(cp))
    expect(jcs(input)).toBe(
      `{"\\r":"Carriage Return","1":"One",${k(0x80)}:"Control",${k(0xf6)}:"Latin Small Letter O With Diaeresis",` +
        `${k(0x20ac)}:"Euro Sign",${k(0x1f600)}:"Emoji: Grinning Face",${k(0xfb33)}:"Hebrew Letter Dalet With Dagesh"}`,
    )
  })

  it('matches RFC 8785 Appendix B number serialization', () => {
    const f = (hex: string) =>
      new DataView(new Uint8Array(Buffer.from(hex, 'hex')).buffer).getFloat64(0)
    const cases: [string, string][] = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ]
    for (const [hex, want] of cases) expect(jcs(f(hex))).toBe(want)
  })

  it('sorts integer-like keys as strings, unlike JS enumeration', () => {
    expect(jcs({ a: 1, 10: 2, 9: 3 })).toBe('{"10":2,"9":3,"a":1}')
    expect(jcs({ x: { 2: 'b', 10: 'a' } })).toBe('{"x":{"10":"a","2":"b"}}')
  })

  it('refuses values JSON cannot hold', () => {
    expect(() => jcs(Number.NaN)).toThrow()
    expect(() => jcs(Infinity)).toThrow()
    expect(() => jcs(undefined)).toThrow()
    expect(() => jcs(10n)).toThrow()
  })
})

describe('record and schema hashes', () => {
  it('keeps v1 hashes for records without integer-like keys', () => {
    // Golden value from v1's hash.test.ts.
    const { hash, canonical } = hashRecord('r1', 'Author', { name: 'Ada', year: 1815 })
    expect(canonical).toBe('{"id":"r1","type":"Author","data":{"name":"Ada","year":1815}}')
    expect(hash).toBe('adefbd10aa438f0c6ed1627817f391ac6cc0441737ee09b4ebcc30fbd8386c63')
    expect(legacyRecordHash('r1', 'Author', { name: 'Ada', year: 1815 })).toBe(hash)
  })

  it('keeps v1 schema hashes without integer-like keys', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } }
    expect(hashSchema(schema)).toBe(
      '2b7196d853bac7cea83330be9c2073848dedc10746eaf403bb5f73687531baf2',
    )
    expect(legacySchemaHash(schema)).toBe(hashSchema(schema))
  })

  it('re-hashes data with integer-like keys, and only that data', () => {
    const data = { 9: 'x', 10: 'y' }
    expect(hasArrayIndexKey(data)).toBe(true)
    expect(hashRecord('r', 't', data).hash).not.toBe(legacyRecordHash('r', 't', data))
    expect(hasArrayIndexKey({ a: [{ b: 1 }], c: '9' })).toBe(false)
    expect(hasArrayIndexKey({ a: [{ '01': 1 }] })).toBe(false) // "01" is not an array index
    expect(hasArrayIndexKey({ a: [{ 4294967295: 1 }] })).toBe(false) // 2^32−1 is not either
    expect(hasArrayIndexKey({ a: [{ 4294967294: 1 }] })).toBe(true)
  })
})
