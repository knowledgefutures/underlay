import { requireRoot, readVersion, readObject } from '../lib/store.js'

export function diff(from: string, to: string): void {
  const root = requireRoot()
  const fromNum = parseInt(from, 10)
  const toNum = parseInt(to, 10)

  const fromVersion = readVersion(root, fromNum)
  const toVersion = readVersion(root, toNum)

  if (!fromVersion) {
    console.error(`Version ${fromNum} not found.`)
    process.exit(1)
  }
  if (!toVersion) {
    console.error(`Version ${toNum} not found.`)
    process.exit(1)
  }

  const fromHashes = new Set(fromVersion.records)
  const toHashes = new Set(toVersion.records)

  const fromRecords = new Map<string, string>()
  const toRecords = new Map<string, string>()

  for (const hash of fromVersion.records) {
    const obj = readObject(root, hash)
    if (obj) {
      const rec = JSON.parse(obj) as { id: string }
      fromRecords.set(rec.id, hash)
    }
  }
  for (const hash of toVersion.records) {
    const obj = readObject(root, hash)
    if (obj) {
      const rec = JSON.parse(obj) as { id: string }
      toRecords.set(rec.id, hash)
    }
  }

  const added: string[] = []
  const removed: string[] = []
  const updated: string[] = []

  for (const [id, hash] of toRecords) {
    const prevHash = fromRecords.get(id)
    if (!prevHash) {
      added.push(id)
    } else if (prevHash !== hash) {
      updated.push(id)
    }
  }
  for (const id of fromRecords.keys()) {
    if (!toRecords.has(id)) removed.push(id)
  }

  console.log(`Diff: v${fromNum} → v${toNum}`)
  console.log(
    `  ${added.length} added, ${updated.length} updated, ${removed.length} removed, ${toRecords.size - added.length - updated.length} unchanged`,
  )

  if (added.length > 0) {
    console.log('\nAdded:')
    for (const id of added) console.log(`  + ${id}`)
  }
  if (updated.length > 0) {
    console.log('\nUpdated:')
    for (const id of updated) console.log(`  ~ ${id}`)
  }
  if (removed.length > 0) {
    console.log('\nRemoved:')
    for (const id of removed) console.log(`  - ${id}`)
  }
}
