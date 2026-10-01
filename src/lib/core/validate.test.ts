import { describe, expect, it } from 'vitest'

import {
  checkSchemaBounds,
  checkTypeSlug,
  compileSchema,
  findExtraFields,
  stripToSchema,
} from './validate.js'

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

describe('compileSchema', () => {
  const schema = () => ({
    $id: 'https://example.org/author',
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  })

  it('reuses the validator for identical schema content', () => {
    expect(compileSchema(schema())).toBe(compileSchema(schema()))
  })

  it('validates records', () => {
    const validate = compileSchema(schema())
    expect(validate({ name: 'Ada' })).toBe(true)
    expect(validate({})).toBe(false)
  })

  it('compiles a changed schema that reuses an $id', () => {
    const changed = { ...schema(), required: [] }
    expect(compileSchema(changed)({})).toBe(true)
  })
})

describe('checkTypeSlug', () => {
  it('accepts ordinary type names', () => {
    for (const slug of ['Author', 'my_type', 'dc:title', 'Type-2', 'a.b']) {
      expect(checkTypeSlug(slug)).toBeNull()
    }
  })

  it('rejects names that could escape the archive directory', () => {
    for (const slug of ['', '..', '.hidden', '../x', 'a/b', 'a\\b', 'a\nb', 'x'.repeat(129)]) {
      expect(checkTypeSlug(slug)).not.toBeNull()
    }
  })

  it('is enforced across a pushed schema set', () => {
    expect(checkSchemaBounds({ Author: {} })).toBeNull()
    expect(checkSchemaBounds({ Author: {}, '../evil': {} })).toMatch(/Type slug/)
  })
})
