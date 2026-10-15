import { describe, expect, it } from 'vitest'

import { compileSchema } from '../src/format.js'
import { schemaRelaxes } from '../src/schema-relax.js'

const base = {
  type: 'object',
  title: 'Work',
  properties: {
    title: { type: 'array', items: { type: 'string' } },
    author: {
      type: 'array',
      items: {
        type: 'object',
        properties: { given: { type: 'string' }, family: { type: 'string' } },
        required: ['family'],
      },
    },
    published: { type: 'object', properties: { year: { type: 'integer' } }, required: ['year'] },
  },
  required: ['title', 'author'],
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('schemaRelaxes', () => {
  it('allows dropping required names, anywhere loosening can only accept more', () => {
    const top = clone(base)
    top.required = ['author']
    expect(schemaRelaxes(base, top)).toBe(true)
    const nested = clone(base)
    nested.properties.author.items.required = []
    expect(schemaRelaxes(base, nested)).toBe(true)
    const gone = clone(base) as Record<string, any>
    delete gone.properties.published.required
    expect(schemaRelaxes(base, gone)).toBe(true)
  })

  it('refuses anything that can reject a record valid before', () => {
    const added = clone(base)
    added.required = ['title', 'author', 'published']
    expect(schemaRelaxes(base, added)).toBe(false)
    const retyped = clone(base) as Record<string, any>
    // A property named "title" is a schema, not an annotation.
    retyped.properties.title = { type: 'string' }
    expect(schemaRelaxes(base, retyped)).toBe(false)
    const newProp = clone(base) as Record<string, any>
    newProp.properties.doi = { type: 'string' }
    expect(schemaRelaxes(base, newProp)).toBe(false)
    const nestedPrivate = clone(base) as Record<string, any>
    nestedPrivate.properties.author.private = true
    expect(schemaRelaxes(base, nestedPrivate)).toBe(false)
  })

  it('ignores annotations and the root private flag', () => {
    const notes = clone(base) as Record<string, any>
    notes.title = 'A work'
    notes.description = 'One work'
    notes.properties.published.$comment = 'year only'
    notes.private = true
    expect(schemaRelaxes(base, notes)).toBe(true)
  })

  it('keeps oneOf, not, if and definitions exact', () => {
    for (const wrap of ['oneOf', 'not', 'if'] as const) {
      const branch = { type: 'object', required: ['a', 'b'] }
      const before = { [wrap]: wrap === 'oneOf' ? [branch, { required: ['c'] }] : branch }
      const looser = { type: 'object', required: ['a'] }
      const after = { [wrap]: wrap === 'oneOf' ? [looser, { required: ['c'] }] : looser }
      expect(schemaRelaxes(before, after)).toBe(false)
    }
    expect(
      schemaRelaxes(
        { definitions: { x: { required: ['a'] } } },
        { definitions: { x: { required: [] } } },
      ),
    ).toBe(false)
  })

  it('gives a schema with $ref only the annotation allowances', () => {
    const before = {
      properties: { a: { $ref: '#/definitions/x' } },
      required: ['a'],
      definitions: { x: {} },
    }
    expect(schemaRelaxes(before, { ...before, required: [] })).toBe(false)
    expect(schemaRelaxes(before, { ...before, title: 'T' })).toBe(true)
  })

  it('accepts every record the old schema accepts, on samples', () => {
    const after = clone(base)
    after.required = ['author']
    after.properties.author.items.required = []
    expect(schemaRelaxes(base, after)).toBe(true)
    const was = compileSchema(base)
    const now = compileSchema(after)
    const samples = [
      { title: ['t'], author: [{ family: 'f' }] },
      { title: ['t'], author: [{ given: 'g', family: 'f' }], published: { year: 2001 } },
      { author: [] },
      { title: 'x', author: [{ given: 1 }] },
    ]
    for (const s of samples) if (was(s).length === 0) expect(now(s)).toEqual([])
  })
})
