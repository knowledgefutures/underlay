import { describe, expect, it } from 'vitest'

import { defaultOrgSlugCandidate, validateSlug } from './slug.js'

describe('defaultOrgSlugCandidate', () => {
  it('derives a slug from the email local part', () => {
    expect(defaultOrgSlugCandidate('Ada.Lovelace@example.com')).toBe('ada-lovelace')
    expect(defaultOrgSlugCandidate('ada@example.com', 2)).toBe('ada-2')
  })

  it('falls back to "user" for reserved or too-short local parts', () => {
    expect(defaultOrgSlugCandidate('admin@example.com')).toBe('user')
    expect(defaultOrgSlugCandidate('a@example.com')).toBe('user')
    expect(defaultOrgSlugCandidate('+@example.com')).toBe('user')
    expect(defaultOrgSlugCandidate('admin@example.com', 1)).toBe('user-1')
  })

  it('never produces a slug validateSlug rejects', () => {
    for (const email of [
      'x@y.z',
      'admin@y.z',
      '--a--@y.z',
      `${'long'.repeat(20)}@y.z`,
      '___@y.z',
      'a.b+tag@y.z',
    ]) {
      for (const attempt of [0, 1, 5]) {
        expect(validateSlug(defaultOrgSlugCandidate(email, attempt))).toBeNull()
      }
    }
  })
})
