import { requireRoot, listVersions, readVersion } from '../lib/store.js'

export function log(): void {
  const root = requireRoot()
  const versions = listVersions(root)

  if (versions.length === 0) {
    console.log('No versions yet.')
    return
  }

  for (const sv of versions.toReversed()) {
    const v = readVersion(root, sv)
    if (!v) continue
    console.log(`${v.semver}  ${v.hash.slice(0, 16)}...`)
    console.log(`  ${v.message}`)
    console.log(`  ${Object.keys(v.schemas).length} type(s), ${v.records.length} record(s)`)
    console.log(`  ${v.createdAt}`)
    console.log()
  }
}
