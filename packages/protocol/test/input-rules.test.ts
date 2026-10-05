import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  compareUtf8,
  InputRuleError,
  parseRecordLine,
  parseStrict,
  scanJson,
} from '../src/index.js'

const code = (f: () => unknown): string | null => {
  try {
    f()
    return null
  } catch (err) {
    return err instanceof InputRuleError ? err.code : `other: ${(err as Error).message}`
  }
}

describe('scanJson', () => {
  it('accepts ordinary JSON', () => {
    expect(
      code(() => scanJson('{"a":[1,2.5,-3,"x",true,false,null,{"b":{}}],"c":"\\"q\\""}')),
    ).toBe(null)
  })

  it('rejects duplicate keys, compared after unescaping', () => {
    expect(code(() => scanJson('{"a":1,"a":2}'))).toBe('duplicate_key')
    expect(code(() => scanJson('{"a":1,"\\u0061":2}'))).toBe('duplicate_key')
    expect(code(() => scanJson('{"x":{"a":1},"y":{"a":1}}'))).toBe(null)
    expect(code(() => scanJson('[{"a":1},{"a":2}]'))).toBe(null)
    expect(code(() => scanJson('{"a":{"a":{"a":1}}}'))).toBe(null)
    // A key inside a nested value doesn't count toward the outer object.
    expect(code(() => scanJson('{"a":{"b":1},"b":2}'))).toBe(null)
  })

  it('rejects integer literals outside ±(2^53−1) and keeps floats', () => {
    expect(code(() => scanJson('[9007199254740991,-9007199254740991]'))).toBe(null)
    expect(code(() => scanJson('[9007199254740992]'))).toBe('unsafe_integer')
    expect(code(() => scanJson('{"n":-9007199254740992}'))).toBe('unsafe_integer')
    expect(code(() => scanJson('[123456789012345678901234567890]'))).toBe('unsafe_integer')
    expect(code(() => scanJson('[1e20,6.02e23,1.5,-0.0,1E+400]'))).toBe(null)
    expect(code(() => scanJson('[9007199254740993.0]'))).toBe(null)
  })

  it('rejects lone surrogates, raw or escaped', () => {
    expect(code(() => scanJson('["\\ud83d\\ude00", "😀"]'))).toBe(null)
    expect(code(() => scanJson('["\\ud83d"]'))).toBe('lone_surrogate')
    expect(code(() => scanJson('["\\ude00"]'))).toBe('lone_surrogate')
    expect(code(() => scanJson('["\\ud83dx"]'))).toBe('lone_surrogate')
    expect(code(() => scanJson('["\ud83d"]'))).toBe('lone_surrogate')
    expect(code(() => scanJson('{"\\ud83d":1}'))).toBe('lone_surrogate')
    // A raw high surrogate followed by an escaped low one decodes to a valid pair.
    expect(code(() => scanJson('["\ud83d\\ude00"]'))).toBe(null)
  })

  it('limits nesting depth', () => {
    expect(code(() => scanJson('[[[]]]', 3))).toBe(null)
    expect(code(() => scanJson('[[[[]]]]', 3))).toBe('too_deep')
    expect(code(() => scanJson('{"a":{"b":{"c":{}}}}', 3))).toBe('too_deep')
    expect(code(() => scanJson('['.repeat(100_000)))).toBe('too_deep')
  })

  it('leaves syntax to JSON.parse', () => {
    expect(code(() => parseStrict('{"a":'))).toBe('syntax')
    expect(code(() => parseStrict('{"a":1}'))).toBe(null)
  })

  it('reports a key that does not unescape as syntax, at any depth', () => {
    for (const text of [
      String.raw`{"id":"a","type":"A","data":{"\x":1}}`,
      String.raw`{"\x":1,"id":"a","type":"A","data":1}`,
      String.raw`{"id":"a","type":"A","data":[{"k":[{"a\q":1}]}]}`,
      // A raw control character, which JSON.parse refuses in any string.
      `{"id":"a","type":"A","data":{"\\n\n":1}}`,
    ]) {
      expect(code(() => parseStrict(text))).toBe('syntax')
      expect(code(() => parseRecordLine(text))).toBe('syntax')
      expect(code(() => scanJson(text))).toBe(null)
    }
  })

  it('requires four hex digits in a \\u escape', () => {
    expect(code(() => scanJson(String.raw`["\u00e9\u00E9"]`))).toBe(null)
    for (const bad of ['12zz', ' 123', '+123', '-123', '12'])
      expect(code(() => scanJson(`["\\u${bad}"]`))).toBe('syntax')
  })

  it('reports the first rule the text breaks, then syntax', () => {
    // A duplicate key before a syntax error.
    expect(code(() => parseStrict('{"a":1,"a":2,"b":}'))).toBe('duplicate_key')
    // A bad escape other than \u is not a scan rule: the duplicate after it is.
    expect(code(() => parseStrict(String.raw`{"\x":1,"a":1,"a":2}`))).toBe('duplicate_key')
    expect(code(() => parseStrict(String.raw`{"a":"\x","a":1}`))).toBe('duplicate_key')
    // A bad \u escape is, and comes first.
    expect(code(() => parseStrict(String.raw`{"a":"\u12zz","a":1}`))).toBe('syntax')
  })

  it('never throws anything but InputRuleError, on any input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const c = code(() => parseStrict(s))
        return c === null || !c.startsWith('other')
      }),
      { numRuns: 2000 },
    )
    // Text made of JSON's own characters reaches keys with escapes.
    const unit = fc.constantFrom(...'{}[]":,\\uxa0e1 ')
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 40 }), (s) => {
        const c = code(() => parseStrict(s))
        return c === null || !c.startsWith('other')
      }),
      { numRuns: 5000 },
    )
  })

  it('accepts every JSON value without unsafe integers, duplicates or lone surrogates', () => {
    const value = fc.jsonValue({ maxDepth: 6 }).filter((v) => {
      const text = JSON.stringify(v)
      return !/\d{16,}/.test(text) && (text ?? '').isWellFormed()
    })
    fc.assert(
      fc.property(value, (v) => code(() => scanJson(JSON.stringify(v))) === null),
      { numRuns: 1000 },
    )
  })
})

describe('parseRecordLine', () => {
  it('parses and canonicalizes a record', () => {
    const r = parseRecordLine(
      '{"type":"Author","id":"r1","data":{"year":1815,"name":"Ada"},"private":true}',
    )
    expect(r).toMatchObject({ id: 'r1', type: 'Author', private: true })
    expect(r.canonical).toBe('{"id":"r1","type":"Author","data":{"name":"Ada","year":1815}}')
  })

  it('rejects bad envelopes', () => {
    expect(code(() => parseRecordLine('[1]'))).toBe('bad_envelope')
    expect(code(() => parseRecordLine('{"id":"r","type":"t"}'))).toBe('bad_envelope')
    expect(code(() => parseRecordLine('{"id":"","type":"t","data":1}'))).toBe('bad_id')
    expect(code(() => parseRecordLine('{"id":1,"type":"t","data":1}'))).toBe('bad_id')
    expect(code(() => parseRecordLine(`{"id":"${'x'.repeat(1025)}","type":"t","data":1}`))).toBe(
      'bad_id',
    )
    expect(code(() => parseRecordLine('{"id":"r","type":"a/b","data":1}'))).toBe('bad_type')
    expect(code(() => parseRecordLine('{"id":"r","type":".x","data":1}'))).toBe('bad_type')
    expect(code(() => parseRecordLine('{"id":"r","type":"t","data":1,"private":"yes"}'))).toBe(
      'bad_envelope',
    )
  })

  it('counts the envelope as one level of nesting', () => {
    const deep = (n: number) => '['.repeat(n) + ']'.repeat(n)
    expect(code(() => parseRecordLine(`{"id":"r","type":"t","data":${deep(64)}}`))).toBe(null)
    expect(code(() => parseRecordLine(`{"id":"r","type":"t","data":${deep(65)}}`))).toBe('too_deep')
  })
})

describe('compareUtf8', () => {
  it('orders like UTF-8 bytes', () => {
    const str = fc.string({ unit: 'grapheme', maxLength: 6 })
    fc.assert(
      fc.property(str, str, (a, b) => {
        const want = Math.sign(Buffer.compare(Buffer.from(a), Buffer.from(b)))
        return Math.sign(compareUtf8(a, b)) === want
      }),
      { numRuns: 5000 },
    )
  })

  it('puts astral characters after U+E000–U+FFFF, unlike JS sort', () => {
    const bmp = String.fromCharCode(0xffff)
    const astral = String.fromCodePoint(0x1f600)
    expect(compareUtf8(bmp, astral)).toBeLessThan(0)
    expect(bmp < astral).toBe(false)
  })
})
