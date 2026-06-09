import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { hashRecord } from '../../lib/core/index.js'
import { appendStagedRecords } from '../lib/staging.js'
import { requireRoot, writeObject } from '../lib/store.js'

export function add(file: string): void {
  const root = requireRoot()
  const content = readFileSync(resolve(file), 'utf-8').trim()
  if (!content) {
    console.error('File is empty.')
    process.exit(1)
  }

  const lines = content.split('\n')
  const hashes: string[] = []

  for (const line of lines) {
    const record = JSON.parse(line) as { id: string; type: string; data: unknown }
    if (!record.id || !record.type || !record.data) {
      console.error(`Invalid record (missing id, type, or data): ${line.slice(0, 80)}...`)
      process.exit(1)
    }
    const { hash, canonical } = hashRecord(record)
    writeObject(root, hash, canonical)
    hashes.push(hash)
  }

  appendStagedRecords(root, lines)
  console.log(`Added ${lines.length} record(s) (${hashes.length} object(s) written)`)
}
