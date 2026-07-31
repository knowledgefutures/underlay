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

/**
 * Streaming form of {@link computeVersionHash}, for versions whose record set is
 * too large to materialize.
 *
 * `computeVersionHash` builds the whole canonical document in memory: a sorted
 * copy of every record hash, then a JSON string containing all of them. At a few
 * million records that is a sorted array plus a ~200 MB string, which is one of
 * the reasons a large push cannot commit.
 *
 * This produces **byte-identical** output by emitting the same document
 * incrementally through the same digest. The caller feeds record hashes in
 * ascending order — which Postgres can supply straight off an index, so nothing
 * is ever fully in memory — and the writer emits the surrounding JSON around
 * them. `version-hash.test.ts` locks the two implementations together against
 * randomized inputs; they must never diverge, or server and CLI version hashes
 * do.
 *
 * Ordering must match `Array.prototype.sort()`, i.e. UTF-16 code-unit order. For
 * the lowercase hex digests this is used with, that is plain byte order — so the
 * SQL side must sort with `COLLATE "C"` and not a locale collation.
 */
export class VersionHashStream {
  #digest = createHash('sha256')
  #wroteRecord = false
  #closed = false

  constructor(
    schemaSet: { slug: string; schemaHash: string }[],
    private readonly fileHashes: string[],
    private readonly metadata: Record<string, unknown> | null,
  ) {
    // JSON.stringify emits object keys in insertion order, so the prefix here
    // has to match computeVersionHash's literal field order exactly.
    const schemas = JSON.stringify(
      Object.fromEntries(
        [...schemaSet]
          .sort((a, b) => a.slug.localeCompare(b.slug))
          .map((s) => [s.slug, s.schemaHash]),
      ),
    )
    this.#digest.update(`{"schemas":${schemas},"records":[`)
  }

  /** Feed the next record hash. Hashes must arrive in ascending sort order. */
  push(recordHash: string): void {
    if (this.#closed) throw new Error('VersionHashStream: push after digest()')
    if (this.#wroteRecord) this.#digest.update(',')
    this.#wroteRecord = true
    this.#digest.update(JSON.stringify(recordHash))
  }

  /** Close the document and return the `private:`-prefixed version hash. */
  digest(): string {
    if (this.#closed) throw new Error('VersionHashStream: digest() called twice')
    this.#closed = true
    const tail = JSON.stringify({
      files: [...this.fileHashes].sort(),
      metadata: this.metadata ? canonicalize(this.metadata) : null,
    })
    // Splice the tail object's fields onto the open document: drop its leading
    // `{` and reuse the rest, which already carries the closing brace.
    this.#digest.update(`],${tail.slice(1)}`)
    return 'private:' + this.#digest.digest('hex')
  }
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
