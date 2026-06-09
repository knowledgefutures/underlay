import { describe, expect, it } from 'vitest'

import { hashRecord, hashSchema } from './hash.js'
import { filterRecordData } from './privacy.js'
import type { SchemaEntry } from './types.js'
import { computePublicHash, computeVersionHash, filterSchemasForPublic } from './version-hash.js'

const entry = (slug: string, schema: Record<string, unknown>): SchemaEntry => ({
  slug,
  schemaId: `id-${slug}`,
  schema,
  schemaHash: hashSchema(schema),
})

describe('computeVersionHash', () => {
  // Golden value: locks the version-hash wire format
  // {"schemas":{...},"records":[...],"files":[...],"metadata":...} with sorted
  // schema slugs and sorted hash arrays. Shared by server push and CLI commit —
  // if this fails, CLI and server version hashes have diverged from the protocol.
  it('matches the golden hash for a known version', () => {
    expect(
      computeVersionHash([{ slug: 'Author', schemaHash: 'aaa' }], ['h2', 'h1'], [], null),
    ).toBe('private:6a382212927aee2474d30565a55f30fe5c128610998190756a41d629422b6dba')
  })

  it('is insensitive to schema-set and record-hash order', () => {
    const a = computeVersionHash(
      [
        { slug: 'B', schemaHash: 'b' },
        { slug: 'A', schemaHash: 'a' },
      ],
      ['h2', 'h1'],
      ['f2', 'f1'],
      null,
    )
    const b = computeVersionHash(
      [
        { slug: 'A', schemaHash: 'a' },
        { slug: 'B', schemaHash: 'b' },
      ],
      ['h1', 'h2'],
      ['f1', 'f2'],
      null,
    )
    expect(a).toBe(b)
  })

  it('canonicalizes metadata key order', () => {
    const a = computeVersionHash([], [], [], { readme: 'x', license: 'MIT' })
    const b = computeVersionHash([], [], [], { license: 'MIT', readme: 'x' })
    expect(a).toBe(b)
  })

  it('does not mutate its input arrays', () => {
    const records = ['h2', 'h1']
    computeVersionHash([], records, [], null)
    expect(records).toEqual(['h2', 'h1'])
  })
})

describe('public record address', () => {
  // A record of a type with private fields has two content-addresses: the full
  // hash (owners) and the public hash — the hash of its filtered projection.
  // Public manifests list the public hash, so a reader verifying
  // hash(what-they-received) reproduces exactly the address they requested.
  it('the filtered projection hashes to the public address', () => {
    const data = { name: 'Ada', email: 'a@b.c' }
    const privateFields = new Set(['email'])
    const fullHash = hashRecord({ id: 'r1', type: 'Author', data }).hash
    const publicHash = hashRecord({
      id: 'r1',
      type: 'Author',
      data: filterRecordData(data, privateFields),
    }).hash
    expect(publicHash).not.toBe(fullHash)
    // A reader holding only the served (filtered) document can verify it
    expect(hashRecord({ id: 'r1', type: 'Author', data: { name: 'Ada' } }).hash).toBe(publicHash)
  })

  it('equals the full hash when the record has none of the private fields set', () => {
    const data = { name: 'Ada' }
    const privateFields = new Set(['email'])
    const fullHash = hashRecord({ id: 'r1', type: 'Author', data }).hash
    const publicHash = hashRecord({
      id: 'r1',
      type: 'Author',
      data: filterRecordData(data, privateFields),
    }).hash
    expect(publicHash).toBe(fullHash)
  })
})

describe('filterSchemasForPublic', () => {
  it('drops private types and strips private fields', () => {
    const result = filterSchemasForPublic([
      entry('Secret', { type: 'object', private: true }),
      entry('Author', {
        type: 'object',
        properties: { name: { type: 'string' }, email: { type: 'string', private: true } },
      }),
    ])
    expect(Object.keys(result)).toEqual(['Author'])
    expect((result['Author'] as any).properties).toEqual({ name: { type: 'string' } })
  })
})

describe('computePublicHash', () => {
  const authorSchema = {
    type: 'object',
    properties: { name: { type: 'string' }, email: { type: 'string', private: true } },
  }
  const secretSchema = { type: 'object', private: true }

  it('excludes private types, private records, and private fields', () => {
    const entries = [entry('Author', authorSchema), entry('Secret', secretSchema)]
    const publicHash = computePublicHash(
      entries,
      [
        { recordId: 'r1', type: 'Author', data: { name: 'Ada', email: 'a@b.c' }, private: false },
        { recordId: 'r2', type: 'Author', data: { name: 'Eda' }, private: true },
        { recordId: 'r3', type: 'Secret', data: { code: 'x' }, private: false },
      ],
      [],
      null,
    )

    // Equivalent hand-built public version: only r1, with email stripped, under
    // the filtered Author schema
    const filteredAuthor = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: undefined,
    }
    const expected = computeVersionHash(
      [{ slug: 'Author', schemaHash: hashSchema(filteredAuthor) }],
      [hashRecord({ id: 'r1', type: 'Author', data: { name: 'Ada' } }).hash],
      [],
      null,
    ).replace('private:', 'public:')

    expect(publicHash).toBe(expected)
    expect(publicHash.startsWith('public:')).toBe(true)
  })

  it('equals the private hash structure when nothing is private', () => {
    const entries = [entry('Author', { type: 'object', properties: { name: {} } })]
    const rows = [{ recordId: 'r1', type: 'Author', data: { name: 'Ada' }, private: false }]
    const publicHash = computePublicHash(entries, rows, [], null)
    const privateEquivalent = computeVersionHash(
      entries.map((e) => ({ slug: e.slug, schemaHash: hashSchema(e.schema) })),
      [hashRecord({ id: 'r1', type: 'Author', data: { name: 'Ada' } }).hash],
      [],
      null,
    )
    expect(publicHash).toBe(privateEquivalent.replace('private:', 'public:'))
  })
})
