import { computeVersionHash, deriveSemver, hashRecord, hashSchema } from '../../lib/core/index.js'
import { parseJsonOrExit } from '../lib/json.js'
import { getStagedSchema, getStagedRecords, clearStaging } from '../lib/staging.js'
import {
  requireRoot,
  getHead,
  readVersion,
  readSchema,
  writeVersion,
  setHead,
  type VersionManifest,
} from '../lib/store.js'

export function commit(message: string): void {
  const root = requireRoot()
  const head = getHead(root)

  const stagedSchema = getStagedSchema(root)
  const stagedRecordLines = getStagedRecords(root)

  if (!stagedSchema && stagedRecordLines.length === 0) {
    console.error('Nothing staged. Use `underlay schema-set` and `underlay add` first.')
    process.exit(1)
  }

  const prev = head ? readVersion(root, head) : null

  const schemas: Record<string, string> = {}
  const schemaSource = stagedSchema ?? (prev ? rebuildSchemas(root, prev) : null)
  if (!schemaSource) {
    console.error('No schema set. Use `underlay schema-set` first.')
    process.exit(1)
  }
  for (const [slug, body] of Object.entries(schemaSource)) {
    schemas[slug] = hashSchema(body)
  }

  const prevRecordSet = new Set(prev?.records ?? [])
  const recordHashes: string[] = [...prevRecordSet]

  for (const [i, line] of stagedRecordLines.entries()) {
    const record = parseJsonOrExit<{ id: string; type: string; data: unknown }>(
      line,
      `staged records (.underlay/staging/records.jsonl), line ${i + 1}`,
      'Fix the corrupt line, or clear staging and re-run `underlay add`.',
    )
    const { hash } = hashRecord(record)
    if (!prevRecordSet.has(hash)) {
      recordHashes.push(hash)
    }
  }

  recordHashes.sort()
  const schemaSet = Object.entries(schemas).map(([slug, schemaHash]) => ({ slug, schemaHash }))
  const hash = computeVersionHash(schemaSet, recordHashes, [], null)

  const schemaChanged = prev ? JSON.stringify(prev.schemas) !== JSON.stringify(schemas) : true
  const recordsChanged = prev
    ? recordHashes.length !== prev.records.length ||
      recordHashes.some((h, i) => h !== prev.records[i])
    : true
  const sv = deriveSemver(prev?.semver ?? null, schemaChanged, recordsChanged)

  const manifest: VersionManifest = {
    semver: sv.semver,
    hash,
    message,
    metadata: null,
    schemas,
    records: recordHashes,
    files: [],
    createdAt: new Date().toISOString(),
  }

  writeVersion(root, manifest)
  setHead(root, sv.semver)
  clearStaging(root)

  console.log(`${sv.semver} committed: ${message}`)
  console.log(`  ${Object.keys(schemas).length} type(s), ${recordHashes.length} record(s)`)
  console.log(`  Hash: ${hash.slice(0, 20)}...`)
}

function rebuildSchemas(root: string, prev: VersionManifest): Record<string, unknown> | null {
  const result: Record<string, unknown> = {}
  for (const [slug, hash] of Object.entries(prev.schemas)) {
    const body = readSchema(root, hash)
    if (!body) return null
    result[slug] = parseJsonOrExit(
      body,
      `stored schema "${slug}" (.underlay/schemas object ${hash})`,
      'The local store is corrupt. Re-run `underlay schema-set` or re-pull from the remote.',
    )
  }
  return Object.keys(result).length > 0 ? result : null
}
