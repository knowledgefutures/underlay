import { describe, expect, it } from 'vitest'

import {
  checkSchema,
  checkSchemaBounds,
  compileSchema,
  findExtraFields,
  MAX_SCHEMA_BYTES,
  SchemaError,
  stripToSchema,
} from '../src/index.js'

const errors = (schema: unknown, data: unknown) => compileSchema(schema)(data)
const valid = (schema: unknown, data: unknown) => errors(schema, data).length === 0
const compileError = (schema: unknown): string | null => {
  try {
    compileSchema(schema)
    return null
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaError)
    return (err as Error).message
  }
}

describe('compileSchema', () => {
  it('reuses the validator for identical schema content', () => {
    const a = compileSchema({ type: 'object', properties: { x: { type: 'string' } } })
    const b = compileSchema({ properties: { x: { type: 'string' } }, type: 'object' })
    expect(b).toBe(a)
  })

  it('does not modify the schema it is given', () => {
    const schema = {
      definitions: { a: { type: 'string' } },
      properties: { x: { $ref: '#/definitions/a' } },
    }
    const before = JSON.stringify(schema)
    compileSchema(schema)({ x: 1 })
    expect(JSON.stringify(schema)).toBe(before)
    expect(Object.getOwnPropertyNames(schema.properties.x)).toEqual(['$ref'])
  })

  it('reports errors as "<instance path> <message>", in AJV wording', () => {
    const schema = {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        nested: { type: 'object', properties: { 'a/b': { type: 'string' } } },
      },
    }
    expect(errors(schema, { id: 1, name: 'x' })).toEqual([])
    expect(errors(schema, { id: 1.5, tags: ['a', 2, 'c'], nested: { 'a/b': 3 } }).sort()).toEqual(
      [
        "/ must have required property 'name'",
        '/id must be integer',
        '/tags must NOT have more than 2 items',
        '/tags/1 must be string',
        '/nested/a~1b must be string',
      ].sort(),
    )
    expect(errors({ type: ['string', 'null'] }, 1)).toEqual(['/ must be string,null'])
  })

  it('checks required and additionalProperties', () => {
    const schema = { required: ['a'], properties: { a: {} }, additionalProperties: false }
    expect(valid(schema, { a: 1 })).toBe(true)
    expect(errors(schema, {})).toEqual(["/ must have required property 'a'"])
    expect(errors(schema, { a: 1, b: 2 })).toEqual(['/ must NOT have additional properties'])
    // A subschema for additional properties applies to each of them.
    expect(errors({ additionalProperties: { type: 'number' } }, { a: 1, b: 'x' })).toEqual([
      '/b must be number',
    ])
  })

  it('checks enum, const, numbers and strings', () => {
    expect(valid({ enum: ['a', 1, null, { k: [1] }] }, { k: [1] })).toBe(true)
    expect(errors({ enum: ['a', 1] }, 'b')).toEqual([
      '/ must be equal to one of the allowed values',
    ])
    expect(errors({ const: 'a' }, 'b')).toEqual(['/ must be equal to constant'])
    expect(errors({ minimum: 2, maximum: 5 }, 1)).toEqual(['/ must be >= 2'])
    expect(errors({ exclusiveMaximum: 5 }, 5)).toEqual(['/ must be < 5'])
    expect(errors({ minLength: 2 }, 'a')).toEqual(['/ must NOT have fewer than 2 characters'])
    expect(errors({ pattern: '^[a-z]+$' }, 'A')).toEqual(['/ must match pattern "^[a-z]+$"'])
    // Patterns are Unicode regexes, as in AJV: \p{…} works.
    expect(valid({ pattern: '^\\p{L}+$' }, 'été')).toBe(true)
  })

  it('checks the formats used in practice', () => {
    const cases: [string, string, boolean][] = [
      ['date', '2024-02-29', true],
      ['date', '2023-02-29', false],
      ['date', '2024-1-01', false],
      ['date-time', '2024-01-01T12:00:00Z', true],
      ['date-time', '2024-01-01T12:00:00.5+01:00', true],
      ['date-time', '2024-01-01 12:00:00Z', true],
      ['date-time', '2024-01-01T12:00:00', false], // no time zone
      ['date-time', '2024-01-01', false],
      ['email', 'a.b+c@example.org', true],
      ['email', 'a@localhost', false], // AJV requires a dot in the domain
      ['email', 'not an email', false],
      ['uri', 'https://example.org/a?b=c#d', true],
      ['uri', 'urn:isbn:0451450523', true],
      ['uri', '/relative/path', false],
      ['uri', 'example.org', false],
      ['uuid', '550e8400-e29b-41d4-a716-446655440000', true],
      ['uuid', 'urn:uuid:550e8400-e29b-41d4-a716-446655440000', true],
      ['uuid', '550e8400e29b41d4a716446655440000', false],
    ]
    for (const [format, value, ok] of cases) {
      expect([format, value, valid({ type: 'string', format }, value)]).toEqual([format, value, ok])
    }
    expect(errors({ format: 'date' }, 'x')).toEqual(['/ must match format "date"'])
    // Formats constrain strings only; other types pass.
    expect(valid({ format: 'date' }, 5)).toBe(true)
  })

  it("leaves the library's own format table alone", async () => {
    const lib = await import('@cfworker/json-schema')
    const before = { ...lib.format } as Record<string, unknown>
    expect(valid({ type: 'string', format: 'byte' }, '!!')).toBe(false)
    expect(valid({ type: 'string', format: 'date-time' }, '2020-01-01T00:00:00')).toBe(false)
    // Our definitions sit beside the library's under their own names.
    for (const [k, v] of Object.entries(before)) expect(lib.format[k as 'date']).toBe(v)
    expect('byte' in lib.format).toBe(false)
    expect(Object.getPrototypeOf(lib.format)).toBe(Object.prototype)
    expect(new lib.Validator({ type: 'string', format: 'byte' }).validate('!!').valid).toBe(true)
  })

  it('ignores unknown formats', () => {
    expect(valid({ type: 'string', format: 'not-a-format' }, 'anything')).toBe(true)
  })

  it('resolves $ref to #/definitions and #/$defs, and applies keywords next to $ref', () => {
    const schema = {
      definitions: { name: { type: 'string', minLength: 1 } },
      $defs: { count: { type: 'integer', minimum: 0 } },
      properties: {
        name: { $ref: '#/definitions/name' },
        count: { $ref: '#/$defs/count' },
        short: { $ref: '#/definitions/name', maxLength: 3 },
      },
    }
    expect(valid(schema, { name: 'a', count: 0, short: 'abc' })).toBe(true)
    expect(errors(schema, { name: '', count: -1, short: 'abcd' }).sort()).toEqual(
      [
        '/count must be >= 0',
        '/name must NOT have fewer than 1 characters',
        '/short must NOT have more than 3 characters',
      ].sort(),
    )
  })

  it('handles a root $ref with sibling definitions (a production schema shape)', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://example.org/schema.json',
      $ref: '#/definitions/Doc',
      definitions: {
        Doc: { type: 'object', required: ['type'], properties: { type: { enum: ['Doc'] } } },
      },
    }
    expect(valid(schema, { type: 'Doc' })).toBe(true)
    expect(errors(schema, { type: 'x' })).toEqual([
      '/type must be equal to one of the allowed values',
    ])
  })

  it('validates recursive schemas', () => {
    const schema = {
      definitions: {
        node: {
          type: 'object',
          properties: { children: { type: 'array', items: { $ref: '#/definitions/node' } } },
        },
      },
      $ref: '#/definitions/node',
    }
    expect(valid(schema, { children: [{ children: [] }] })).toBe(true)
    expect(errors(schema, { children: [{ children: [5] }] })).toEqual([
      '/children/0/children/0 must be object',
    ])
  })

  it('ignores unknown keywords, like AJV with strict: false', () => {
    const schema = {
      type: 'object',
      'x-ref-type': 'Community',
      version: '1.0',
      properties: { a: { type: 'string', 'x-ui': { widget: 'text' }, private: false } },
    }
    expect(valid(schema, { a: 'x' })).toBe(true)
  })

  it('ignores keywords from later drafts, as draft-07 does', () => {
    expect(valid({ properties: { a: {} }, unevaluatedProperties: false }, { b: 1 })).toBe(true)
    expect(valid({ dependentRequired: { a: ['b'] } }, { a: 1 })).toBe(true)
    expect(valid({ prefixItems: [{ type: 'string' }] }, [1])).toBe(true)
    expect(valid({ contains: { type: 'string' }, minContains: 2 }, ['a'])).toBe(true)
    // ...but a property that happens to be named like one is still a property.
    expect(errors({ properties: { prefixItems: { type: 'string' } } }, { prefixItems: 1 })).toEqual(
      ['/prefixItems must be string'],
    )
    // draft-07's own `dependencies` applies.
    expect(errors({ dependencies: { a: ['b'] } }, { a: 1 })).toEqual([
      '/ must have property b when property a is present',
    ])
  })

  it('accepts boolean subschemas, but not at the root', () => {
    expect(valid({ properties: { a: true } }, { a: 1 })).toBe(true)
    expect(errors({ properties: { a: false } }, { a: 1 })).toEqual(['/a boolean schema is false'])
    expect(compileError(true)).toBe('schema must be an object')
  })

  it('treats inherited JavaScript names as ordinary property names', () => {
    expect(errors({ required: ['toString'] }, {})).toEqual([
      "/ must have required property 'toString'",
    ])
    expect(valid({ properties: { constructor: { type: 'string' } } }, {})).toBe(true)
    expect(errors({ properties: { constructor: { type: 'string' } } }, { constructor: 1 })).toEqual(
      ['/constructor must be string'],
    )
    expect(errors({ dependencies: { toString: ['b'] } }, {})).toEqual([])
    expect(valid({ type: 'string', format: 'hasOwnProperty' }, 'x')).toBe(true)
    // JSON.parse makes "__proto__" an ordinary key; an object literal would not.
    const schema = JSON.parse(
      '{"required":["__proto__"],"properties":{"__proto__":{"required":["b"]}}}',
    )
    expect(errors(schema, JSON.parse('{"__proto__": {"a": 1}}'))).toEqual([
      "/__proto__ must have required property 'b'",
    ])
    expect(errors(schema, {})).toEqual(["/ must have required property '__proto__'"])
  })

  it('applies multipleOf with a tolerance, unlike AJV', () => {
    // 0.07 / 0.01 is 7.000000000000001 in binary floating point; AJV (v1)
    // rejected it. The tolerance is the library's: |remainder| < 1.1920929e-7.
    expect(valid({ multipleOf: 0.01 }, 0.07)).toBe(true)
    expect(errors({ multipleOf: 0.01 }, 0.075)).toEqual(['/ must be multiple of 0.01'])
  })

  it('resolves $ref to the draft-07 meta-schema, as AJV does', () => {
    const schema = { $ref: 'http://json-schema.org/draft-07/schema#' }
    expect(valid(schema, { type: 'string' })).toBe(true)
    expect(valid(schema, { type: 3 })).toBe(false)
  })

  it('reports AJV-style messages for dependencies, uniqueItems and propertyNames', () => {
    expect(errors({ dependencies: { a: ['b', 'c'] } }, { a: 1, c: 1 })).toEqual([
      '/ must have properties b, c when property a is present',
    ])
    expect(errors({ uniqueItems: true }, [1, 2, 1, 2])).toEqual([
      '/ must NOT have duplicate items (items ## 1 and 3 are identical)',
    ])
    expect(errors({ propertyNames: { maxLength: 2 } }, { abc: 1 }).sort()).toEqual([
      '/ must NOT have more than 2 characters',
      '/ property name must be valid',
    ])
  })

  it('never reports an invalid record as valid, whatever its property names', () => {
    // From the JSON Schema Test Suite (draft7/dependencies.json): a newline in a
    // property name once stopped the message from being worded, and the error
    // was dropped with it.
    const v = compileSchema({ dependencies: { 'foo\nbar': ['foo\rbar'] } })
    expect(v({ 'foo\nbar': 1, foo: 2 })).toEqual([
      '/ must have property foo\rbar when property foo\nbar is present',
    ])
    expect(v({ 'foo\nbar': 1, 'foo\rbar': 2 })).toEqual([])
    const r = compileSchema({ required: ['a\nb'] })
    expect(r({})).toEqual(["/ must have required property 'a\nb'"])
  })

  it('refuses a schema nested too deeply to compile', () => {
    let deep: unknown = {}
    for (let i = 0; i < 20_000; i++) deep = { items: deep }
    expect(compileError(deep)).toMatch(/^schema could not be compiled|^schema is invalid/)
  })

  it('rejects schemas that are not valid draft-07', () => {
    expect(compileError('string')).toBe('schema must be an object')
    expect(compileError({ type: 'text' })).toMatch(/^schema is invalid: /)
    expect(compileError({ required: 'a' })).toMatch(/^schema is invalid: /)
    expect(compileError({ pattern: '(' })).toMatch(/^schema is invalid: /)
    expect(compileError({ $ref: '#/definitions/missing' })).toBe(
      "can't resolve reference #/definitions/missing",
    )
  })

  it('accepts draft-07 $schema and refuses other drafts', () => {
    expect(compileError({ $schema: 'http://json-schema.org/draft-07/schema#' })).toBe(null)
    expect(compileError({ $schema: 'http://json-schema.org/draft-07/schema' })).toBe(null)
    expect(compileError({ $schema: 'https://json-schema.org/draft/2020-12/schema' })).toMatch(
      /^unsupported \$schema/,
    )
    expect(compileError({ $schema: 'http://json-schema.org/draft-04/schema#' })).toMatch(
      /^unsupported \$schema/,
    )
  })

  it('reports every error, except in schemas with branching keywords', () => {
    const data = { a: 1, b: 2 }
    const props = { a: { type: 'string' }, b: { type: 'string' } }
    expect(errors({ properties: props }, data)).toEqual(['/a must be string', '/b must be string'])
    // With anyOf/oneOf/not/if/contains anywhere, a properties or items loop
    // stops at its first failure: reporting everything is exponential there.
    expect(errors({ properties: props, not: { type: 'null' } }, data)).toEqual([
      '/a must be string',
    ])
    expect(valid({ properties: props, not: { type: 'null' } }, { a: 'x', b: 'y' })).toBe(true)
  })

  it('stays fast on a deep record under a recursive oneOf schema', () => {
    // The shape that made exhaustive checking exponential (a production schema).
    const schema = {
      $ref: '#/definitions/node',
      definitions: {
        node: {
          oneOf: [
            {
              type: 'object',
              required: ['type'],
              properties: {
                type: { const: 'a' },
                children: { type: 'array', items: { $ref: '#/definitions/node' } },
              },
            },
            {
              type: 'object',
              required: ['type'],
              properties: {
                type: { const: 'b' },
                children: { type: 'array', items: { $ref: '#/definitions/node' } },
              },
            },
            {
              type: 'object',
              required: ['type'],
              properties: {
                type: { const: 'c' },
                children: { type: 'array', items: { $ref: '#/definitions/node' } },
              },
            },
          ],
        },
      },
    }
    let data: unknown = { type: 'c' }
    for (let i = 0; i < 40; i++)
      data = { type: i % 2 ? 'a' : 'b', children: [data, { type: 'c', x: 1 }] }
    const started = performance.now()
    expect(valid(schema, data)).toBe(true)
    expect(valid(schema, { type: 'a', children: [{ type: 'z' }] })).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('reports a schema that recurses without consuming data instead of throwing', () => {
    const v = compileSchema({ $ref: '#' })
    expect(v(1)[0]).toMatch(/^\/ schema could not be applied/)
  })
})

describe('checkSchema', () => {
  it('accepts ordinary schemas, and a private type', () => {
    expect(
      checkSchema('Person', { type: 'object', properties: { name: { type: 'string' } } }),
    ).toBe(null)
    expect(checkSchema('Secret', { private: true, type: 'object' })).toBe(null)
    expect(checkSchema('Open', { private: false })).toBe(null)
  })

  it('rejects field-level privacy, at any depth', () => {
    expect(
      checkSchema('Person', { properties: { ssn: { type: 'string', private: true } } }),
    ).toMatch(/marks property "\/properties\/ssn" as private/)
    expect(
      checkSchema('Person', {
        definitions: { a: { properties: { b: { properties: { c: { private: true } } } } } },
      }),
    ).toMatch(/"\/definitions\/a\/properties\/b\/properties\/c"/)
    // A property named "private", or private in a data position, is not the marker.
    expect(checkSchema('T', { properties: { private: { type: 'boolean' } } })).toBe(null)
    expect(
      checkSchema('T', {
        properties: { a: { default: { properties: { b: { private: true } } } } },
      }),
    ).toBe(null)
  })

  it('requires a root "private" to be a boolean', () => {
    expect(checkSchema('T', { private: 'true' })).toMatch(/"private" must be a boolean/)
  })

  it('bounds size on the canonical form', () => {
    const big = { description: 'x'.repeat(MAX_SCHEMA_BYTES) }
    expect(checkSchema('T', big)).toMatch(/exceeds maximum size/)
    // Whitespace isn't counted: the limit applies to the JCS bytes.
    const fits = { description: 'x'.repeat(MAX_SCHEMA_BYTES - 20) }
    expect(checkSchema('T', fits)).toBe(null)
    // Multi-byte characters count as their UTF-8 length.
    const wide = { description: 'é'.repeat(MAX_SCHEMA_BYTES / 2) }
    expect(checkSchema('T', wide)).toMatch(/exceeds maximum size/)
  })

  it('bounds pattern length, including patternProperties keys', () => {
    const long = 'a'.repeat(257)
    expect(checkSchema('T', { properties: { a: { pattern: 'a'.repeat(256) } } })).toBe(null)
    expect(checkSchema('T', { properties: { a: { pattern: long } } })).toMatch(
      /"pattern" longer than 256/,
    )
    expect(checkSchema('T', { patternProperties: { [long]: {} } })).toMatch(
      /"patternProperties" pattern longer than 256/,
    )
  })

  it('checks type slugs', () => {
    expect(checkSchema('a/b', {})).toMatch(/Invalid type slug "a\/b"/)
    expect(checkSchema('.hidden', {})).toMatch(/Invalid type slug/)
  })

  it('checkSchemaBounds returns the first error in a set', () => {
    expect(checkSchemaBounds({ A: {}, B: { type: 'object' } })).toBe(null)
    expect(checkSchemaBounds({ A: {}, B: { properties: { x: { private: true } } } })).toMatch(
      /^Schema "B"/,
    )
  })
})

describe('extra fields', () => {
  const schemas = { T: { properties: { a: {}, b: {} } }, Open: {} }

  it('findExtraFields lists top-level fields not in properties', () => {
    expect(
      findExtraFields(
        [
          { recordId: '1', type: 'T', data: { a: 1, c: 2, d: 3 } },
          { recordId: '2', type: 'T', data: { a: 1 } },
          { recordId: '3', type: 'Open', data: { z: 1 } },
          { recordId: '4', type: 'T', data: 'scalar' },
          { recordId: '5', type: 'T', data: { toString: 1 } },
        ],
        schemas,
      ),
    ).toEqual([
      { recordId: '1', type: 'T', fields: ['c', 'd'] },
      { recordId: '5', type: 'T', fields: ['toString'] },
    ])
  })

  it('stripToSchema keeps only listed top-level fields', () => {
    expect(stripToSchema({ a: 1, c: 2, b: { x: 1 } }, { a: {}, b: {} })).toEqual({
      a: 1,
      b: { x: 1 },
    })
    expect(stripToSchema({ constructor: 1 }, {})).toEqual({})
  })
})
