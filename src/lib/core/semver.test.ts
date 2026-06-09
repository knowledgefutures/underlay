import { describe, expect, it } from 'vitest'

import { compareSemver, deriveSemver, parseSemver } from './semver.js'

describe('parseSemver', () => {
  it('parses full semver with and without v prefix', () => {
    expect(parseSemver('v1.2.3')).toEqual({ semver: 'v1.2.3', major: 1, minor: 2, patch: 3 })
    expect(parseSemver('1.2.3')).toEqual({ semver: 'v1.2.3', major: 1, minor: 2, patch: 3 })
  })

  it('fills missing components with zeros', () => {
    expect(parseSemver('v2')).toEqual({ semver: 'v2.0.0', major: 2, minor: 0, patch: 0 })
    expect(parseSemver('v1.2')).toEqual({ semver: 'v1.2.0', major: 1, minor: 2, patch: 0 })
  })
})

describe('compareSemver', () => {
  it('orders versions numerically by major, minor, patch', () => {
    expect(compareSemver('v1.0.0', 'v2.0.0')).toBeLessThan(0)
    expect(compareSemver('v2.0.0', 'v1.9.9')).toBeGreaterThan(0)
    expect(compareSemver('v1.2.0', 'v1.10.0')).toBeLessThan(0)
    expect(compareSemver('v1.2.3', 'v1.2.10')).toBeLessThan(0)
    expect(['v1.10.0', 'v1.2.0', 'v2.0.0', 'v1.2.3'].sort(compareSemver)).toEqual([
      'v1.2.0',
      'v1.2.3',
      'v1.10.0',
      'v2.0.0',
    ])
  })

  it('handles mixed v-prefix and bare versions', () => {
    expect(compareSemver('1.2.3', 'v1.2.4')).toBeLessThan(0)
    expect(compareSemver('v2.0.0', '1.9.9')).toBeGreaterThan(0)
  })

  it('returns 0 for equal versions', () => {
    expect(compareSemver('v1.2.3', 'v1.2.3')).toBe(0)
    expect(compareSemver('1.2.3', 'v1.2.3')).toBe(0)
  })
})

describe('deriveSemver', () => {
  it('starts at v1.0.0 with no previous version', () => {
    expect(deriveSemver(null, true, true).semver).toBe('v1.0.0')
    expect(deriveSemver(null, false, false).semver).toBe('v1.0.0')
  })

  it('major-bumps on schema change (resets minor/patch)', () => {
    expect(deriveSemver('v1.2.3', true, true).semver).toBe('v2.0.0')
  })

  it('minor-bumps on record change with same schema', () => {
    expect(deriveSemver('v1.2.3', false, true).semver).toBe('v1.3.0')
  })

  it('patch-bumps on metadata-only change', () => {
    expect(deriveSemver('v1.2.3', false, false, true).semver).toBe('v1.2.4')
  })

  it('schema change takes precedence over record change', () => {
    expect(deriveSemver('v3.5.1', true, false).semver).toBe('v4.0.0')
  })
})
