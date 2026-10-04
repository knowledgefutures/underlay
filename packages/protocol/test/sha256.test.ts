import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  nativeSha256,
  portableSha256,
  portableSha256Hex,
  sha256,
  sha256Hex,
} from '../src/sha256.js'

describe('sha256', () => {
  it('is native under Node', () => {
    expect(nativeSha256).toBe(true)
  })

  it('the browser fallback matches the native hash (property)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary' }), fc.uint8Array()), (input) => {
        expect(portableSha256Hex(input)).toBe(sha256Hex(input))
        expect(portableSha256(input)).toEqual(new Uint8Array(sha256(input)))
      }),
      { numRuns: 500 },
    )
    expect(portableSha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
