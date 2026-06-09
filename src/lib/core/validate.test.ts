import { describe, expect, it } from 'vitest'

import { findExtraFields, stripToSchema } from './validate.js'

describe('findExtraFields', () => {
  const schemas = {
    Author: { properties: { name: {}, year: {} } },
  }

  it('reports fields not present in the schema', () => {
    const warnings = findExtraFields(
      [{ recordId: 'r1', type: 'Author', data: { name: 'Ada', nickname: 'A' } }],
      schemas,
    )
    expect(warnings).toEqual([{ recordId: 'r1', type: 'Author', fields: ['nickname'] }])
  })

  it('returns nothing for conforming records or unknown types', () => {
    expect(
      findExtraFields(
        [
          { recordId: 'r1', type: 'Author', data: { name: 'Ada' } },
          { recordId: 'r2', type: 'Unknown', data: { anything: 1 } },
        ],
        schemas,
      ),
    ).toEqual([])
  })
})

describe('stripToSchema', () => {
  it('keeps only schema-declared keys', () => {
    expect(stripToSchema({ name: 'Ada', extra: 1 }, { name: {} })).toEqual({ name: 'Ada' })
  })
})
