import { describe, expect, it } from 'vitest'

import { parseLimit, parseOffset } from './query-params.js'

describe('parseLimit', () => {
  it('uses the default when absent or invalid', () => {
    expect(parseLimit(undefined, 50, 100)).toBe(50)
    expect(parseLimit('abc', 50, 100)).toBe(50)
    expect(parseLimit('-1', 50, 100)).toBe(50)
  })

  it('caps at the maximum', () => {
    expect(parseLimit('500', 50, 100)).toBe(100)
  })

  it('passes valid values through', () => {
    expect(parseLimit('0', 50, 100)).toBe(0)
    expect(parseLimit('25', 50, 100)).toBe(25)
  })
})

describe('parseOffset', () => {
  it('is 0 when absent or invalid', () => {
    expect(parseOffset(undefined)).toBe(0)
    expect(parseOffset('x')).toBe(0)
    expect(parseOffset('-5')).toBe(0)
  })

  it('passes valid values through', () => {
    expect(parseOffset('40')).toBe(40)
  })
})
