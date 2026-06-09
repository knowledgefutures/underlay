import { createHash } from 'node:crypto'

import { hashRecord, hashSchema, deriveSemver } from '../../lib/core/index.js'
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

  if (stagedRecordLines.length > 0) {
    for (const line of stagedRecordLines) {
      const record = JSON.parse(line) as { id: string; type: string; data: unknown }
      const { hash } = hashRecord(record)
      if (!prevRecordSet.has(hash)) {
        recordHashes.push(hash)
      }
    }
  }

  recordHashes.sort()
  const sortedSchemaEntries = Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))
  const canonical = JSON.stringify({
    schemas: Object.fromEntries(sortedSchemaEntries),
    records: recordHashes,
    files: [],
    metadata: null,
  })
  const hash = 'private:' + createHash('sha256').update(canonical).digest('hex')

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
    result[slug] = JSON.parse(body)
  }
  return Object.keys(result).length > 0 ? result : null
}
