import { describe, expect, it } from 'vitest'

import { filterRecordData, filterTypeSchema, getPrivateFields, getPrivateTypes } from './privacy.js'
import type { SchemaEntry } from './types.js'

const entry = (slug: string, schema: Record<string, unknown>): SchemaEntry => ({
  slug,
  schemaId: `id-${slug}`,
  schema,
  schemaHash: `hash-${slug}`,
})

describe('getPrivateTypes', () => {
  it('returns slugs of schemas with root private:true', () => {
    const entries = [
      entry('Public', { type: 'object' }),
      entry('Secret', { type: 'object', private: true }),
      entry('AlsoPublic', { type: 'object', private: false }),
    ]
    expect(getPrivateTypes(entries)).toEqual(new Set(['Secret']))
  })
})

describe('getPrivateFields', () => {
  it('returns property names marked private:true', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string', private: true },
        ssn: { type: 'string', private: true },
      },
    }
    expect(getPrivateFields(schema)).toEqual(new Set(['email', 'ssn']))
  })

  it('returns empty set when there are no properties', () => {
    expect(getPrivateFields({ type: 'object' })).toEqual(new Set())
  })
})

describe('filterRecordData', () => {
  it('strips private fields from record data', () => {
    expect(filterRecordData({ name: 'Ada', email: 'a@b.c' }, new Set(['email']))).toEqual({
      name: 'Ada',
    })
  })

  it('returns data unchanged when no private fields', () => {
    const data = { name: 'Ada' }
    expect(filterRecordData(data, new Set())).toBe(data)
  })

  it('passes through non-object data', () => {
    expect(filterRecordData(null, new Set(['x']))).toBe(null)
    expect(filterRecordData('s', new Set(['x']))).toBe('s')
  })
})

describe('filterTypeSchema', () => {
  it('removes private properties and prunes them from required', () => {
    const filtered = filterTypeSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string', private: true },
      },
      required: ['name', 'email'],
    })
    expect(filtered.properties).toEqual({ name: { type: 'string' } })
    expect(filtered.required).toEqual(['name'])
  })

  it('returns schema unchanged when there are no properties', () => {
    const schema = { type: 'object' }
    expect(filterTypeSchema(schema)).toBe(schema)
  })
})
