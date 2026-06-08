import { hashRecord, hashSchema } from '@underlay/core'

import { getStagedSchema, getStagedRecords } from '../lib/staging.js'
import { requireRoot, getHead, readVersion } from '../lib/store.js'

export function status(): void {
  const root = requireRoot()
  const head = getHead(root)

  console.log(`HEAD: version ${head}`)

  const stagedSchema = getStagedSchema(root)
  const stagedRecords = getStagedRecords(root)

  if (!stagedSchema && stagedRecords.length === 0) {
    console.log('Nothing staged.')
    return
  }

  if (stagedSchema) {
    const typeSlugs = Object.keys(stagedSchema)
    if (head === 0) {
      console.log(`\nSchema (new): ${typeSlugs.length} type(s)`)
      for (const slug of typeSlugs) {
        console.log(`  + ${slug}`)
      }
    } else {
      const prev = readVersion(root, head)
      const prevSlugs = prev ? Object.keys(prev.schemas) : []
      const added = typeSlugs.filter((s) => !prevSlugs.includes(s))
      const removed = prevSlugs.filter((s) => !typeSlugs.includes(s))
      const changed = typeSlugs.filter((s) => {
        if (!prev?.schemas[s]) return false
        return hashSchema(stagedSchema[s]) !== prev.schemas[s]
      })

      if (added.length || removed.length || changed.length) {
        console.log('\nSchema changes:')
        for (const s of added) console.log(`  + ${s} (new type)`)
        for (const s of removed) console.log(`  - ${s} (removed)`)
        for (const s of changed) console.log(`  ~ ${s} (modified)`)
      } else {
        console.log('\nSchema: unchanged')
      }
    }
  }

  if (stagedRecords.length > 0) {
    const records = stagedRecords.map(
      (line) => JSON.parse(line) as { id: string; type: string; data: unknown },
    )
    const byType = new Map<string, number>()
    for (const r of records) {
      byType.set(r.type, (byType.get(r.type) ?? 0) + 1)
    }

    if (head === 0) {
      console.log(`\nRecords (new): ${records.length} total`)
      for (const [type, count] of byType) {
        console.log(`  + ${count} ${type}`)
      }
    } else {
      const prev = readVersion(root, head)
      const prevHashes = new Set(prev?.records ?? [])
      const newHashes = records.map((r) => hashRecord(r).hash)
      const added = newHashes.filter((h) => !prevHashes.has(h))
      console.log(`\nRecords: ${records.length} staged (${added.length} new)`)
      for (const [type, count] of byType) {
        console.log(`  ${count} ${type}`)
      }
    }
  }
}
