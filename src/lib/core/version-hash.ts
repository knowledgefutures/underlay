import { createHash } from 'node:crypto'

import { canonicalize, hashRecord, hashSchema } from './hash.js'
import { filterRecordData, filterTypeSchema, getPrivateFields, getPrivateTypes } from './privacy.js'
import type { SchemaEntry } from './types.js'

/**
 * Compute the private (all-content) version hash.
 * This is the protocol's version content-address — shared by server and CLI.
 */
export function computeVersionHash(
  schemaSet: { slug: string; schemaHash: string }[],
  recordHashes: string[],
  fileHashes: string[],
  metadata: Record<string, unknown> | null,
): string {
  const canonical = JSON.stringify({
    schemas: Object.fromEntries(
      [...schemaSet]
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((s) => [s.slug, s.schemaHash]),
    ),
    records: [...recordHashes].sort(),
    files: [...fileHashes].sort(),
    metadata: metadata ? canonicalize(metadata) : null,
  })
  return 'private:' + createHash('sha256').update(canonical).digest('hex')
}

/** Build a public-facing schemas map (excluding private types, stripping private fields) */
export function filterSchemasForPublic(schemaEntries: SchemaEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const entry of schemaEntries) {
    if ((entry.schema as any)?.private === true) continue
    result[entry.slug] = filterTypeSchema(entry.schema)
  }
  return result
}

/** Compute the public (privacy-filtered) version hash */
export function computePublicHash(
  schemaEntries: SchemaEntry[],
  recordRows: { recordId: string; type: string; data: unknown; private: boolean }[],
  fileHashes: string[],
  metadata: Record<string, unknown> | null,
): string {
  const privateTypes = getPrivateTypes(schemaEntries)

  const publicSchemaSet: { slug: string; schemaHash: string }[] = []
  for (const entry of schemaEntries) {
    if (privateTypes.has(entry.slug)) continue
    const filtered = filterTypeSchema(entry.schema)
    publicSchemaSet.push({ slug: entry.slug, schemaHash: hashSchema(filtered) })
  }

  const publicRecordHashes = recordRows
    .filter((r) => !r.private && !privateTypes.has(r.type))
    .map((r) => {
      const entry = schemaEntries.find((e) => e.slug === r.type)
      const privateFields = entry ? getPrivateFields(entry.schema) : new Set<string>()
      const data = privateFields.size > 0 ? filterRecordData(r.data, privateFields) : r.data
      return hashRecord({ id: r.recordId, type: r.type, data }).hash
    })

  return computeVersionHash(publicSchemaSet, publicRecordHashes, fileHashes, metadata).replace(
    'private:',
    'public:',
  )
}
