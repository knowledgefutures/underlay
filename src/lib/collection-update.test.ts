import { describe, expect, it } from 'vitest'

import { checkRestrictedChanges, restrictedChanges } from './collection-update.js'

const current = { slug: 'a', public: false }

describe('restrictedChanges', () => {
  it('ignores name-only and no-op updates', () => {
    expect(restrictedChanges({ name: 'x' }, current)).toEqual([])
    expect(restrictedChanges({ name: 'x', slug: 'a', public: false }, current)).toEqual([])
  })
  it('flags real slug and public changes', () => {
    expect(restrictedChanges({ slug: 'b' }, current)).toEqual(['slug'])
    expect(restrictedChanges({ public: true }, current)).toEqual(['public'])
    expect(restrictedChanges({ slug: 'b', public: true }, current)).toEqual(['slug', 'public'])
  })
})

describe('checkRestrictedChanges', () => {
  it('allows anyone when nothing restricted changes', () => {
    expect(checkRestrictedChanges([], { role: 'member', keyScoped: true })).toBeNull()
  })
  it('allows owner and admin with an unscoped key', () => {
    expect(checkRestrictedChanges(['public'], { role: 'owner', keyScoped: false })).toBeNull()
    expect(checkRestrictedChanges(['slug'], { role: 'admin', keyScoped: false })).toBeNull()
  })
  it('rejects members and non-members', () => {
    expect(checkRestrictedChanges(['public'], { role: 'member', keyScoped: false })).toMatch(
      /owner or admin/,
    )
    expect(checkRestrictedChanges(['slug'], { role: null, keyScoped: false })).toMatch(
      /owner or admin/,
    )
  })
  it('rejects scoped keys even for owners', () => {
    expect(checkRestrictedChanges(['slug'], { role: 'owner', keyScoped: true })).toMatch(/scoped/)
  })
})
