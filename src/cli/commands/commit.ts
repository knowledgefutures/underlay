import { createHash } from 'node:crypto'

import { hashRecord, hashSchema, deriveSemver } from '../../lib/core/index.js'
import { getStagedSchema, getStagedRecords, clearStaging } from '../lib/staging.js'
import {
  requireRoot,
  getHead,
  readVersion,
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

  const prev = head > 0 ? readVersion(root, head) : null

  const schemas: Record<string, string> = {}
  const schemaSource = stagedSchema ?? (prev ? rebuildSchemas(prev) : null)
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
    readme: null,
  })
  const hash = 'private:' + createHash('sha256').update(canonical).digest('hex')

  const schemaChanged = prev ? JSON.stringify(prev.schemas) !== JSON.stringify(schemas) : true
  const recordsChanged = prev
    ? recordHashes.length !== prev.records.length ||
      recordHashes.some((h, i) => h !== prev.records[i])
    : true
  const semver = deriveSemver(prev?.semver ?? null, schemaChanged, recordsChanged)

  const newNumber = head + 1
  const manifest: VersionManifest = {
    number: newNumber,
    semver,
    hash,
    message,
    schemas,
    records: recordHashes,
    files: [],
    createdAt: new Date().toISOString(),
  }

  writeVersion(root, manifest)
  setHead(root, newNumber)
  clearStaging(root)

  console.log(`Version ${newNumber} (${semver}) committed: ${message}`)
  console.log(`  ${Object.keys(schemas).length} type(s), ${recordHashes.length} record(s)`)
  console.log(`  Hash: ${hash.slice(0, 20)}...`)
}

function rebuildSchemas(prev: VersionManifest): Record<string, unknown> | null {
  return null
}
