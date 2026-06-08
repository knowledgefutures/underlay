import { hashRecord } from '@underlay/core'

import { readConfig } from '../lib/config.js'
import {
  requireRoot,
  getHead,
  readVersion,
  writeVersion,
  writeObject,
  writeSchema,
  setHead,
  hasObject,
  type VersionManifest,
} from '../lib/store.js'

export async function pull(remoteName: string = 'origin'): Promise<void> {
  const root = requireRoot()
  const config = readConfig(root)
  const remote = config.remotes[remoteName]

  if (!remote) {
    console.error(`Remote "${remoteName}" not found.`)
    process.exit(1)
  }
  if (!remote.collection) {
    console.error(`Remote "${remoteName}" has no collection set.`)
    process.exit(1)
  }

  const baseUrl = `${remote.url}/api/collections/${remote.collection}`
  const head = getHead(root)

  // 1. Get remote latest
  const latestRes = await fetch(`${baseUrl}/versions/latest`, {
    headers: remote.token ? { Authorization: `Bearer ${remote.token}` } : {},
  })
  if (!latestRes.ok) {
    console.error(`Failed to fetch latest version (${latestRes.status})`)
    process.exit(1)
  }

  const latest = (await latestRes.json()) as { number: number; semver: string }
  if (latest.number <= head) {
    console.log(`Already up to date (local: ${head}, remote: ${latest.number})`)
    return
  }

  console.log(`Pulling version ${latest.number} (${latest.semver})...`)

  // 2. Get manifest (with delta if we have a previous version)
  const manifestUrl =
    head > 0
      ? `${baseUrl}/versions/${latest.number}/manifest?since=${head}`
      : `${baseUrl}/versions/${latest.number}/manifest`

  const manifestRes = await fetch(manifestUrl, {
    headers: remote.token ? { Authorization: `Bearer ${remote.token}` } : {},
  })
  if (!manifestRes.ok) {
    console.error(`Failed to fetch manifest (${manifestRes.status})`)
    process.exit(1)
  }

  const manifest = (await manifestRes.json()) as {
    version: number
    records: Array<{ id: string; type: string; hash: string }>
    schemas: Record<string, { hash: string; schema: unknown }>
    delta?: {
      added: Array<{ id: string; type: string; hash: string }>
      updated: Array<{ id: string; type: string; hash: string }>
      removed: Array<{ id: string; type: string; hash: string }>
    }
  }

  // 3. Store schemas
  const schemaMap: Record<string, string> = {}
  if (manifest.schemas) {
    for (const [slug, entry] of Object.entries(manifest.schemas)) {
      writeSchema(root, entry.hash, JSON.stringify(entry.schema))
      schemaMap[slug] = entry.hash
    }
  }

  // 4. Figure out which record hashes we need
  const allHashes = manifest.records.map((r) => r.hash)
  const needed = allHashes.filter((h) => !hasObject(root, h))

  if (needed.length > 0) {
    console.log(`Fetching ${needed.length} of ${allHashes.length} records...`)

    // Batch fetch missing records
    const batchRes = await fetch(`${remote.url}/api/records/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote.token ? { Authorization: `Bearer ${remote.token}` } : {}),
      },
      body: JSON.stringify({ hashes: needed }),
    })

    if (batchRes.ok && batchRes.body) {
      const text = await batchRes.text()
      for (const line of text.trim().split('\n')) {
        if (!line) continue
        const rec = JSON.parse(line) as { id: string; type: string; data: unknown }
        const { hash, canonical } = hashRecord(rec)
        writeObject(root, hash, canonical)
      }
    }
  } else {
    console.log('All records already local.')
  }

  // 5. Create local version
  const versionManifest: VersionManifest = {
    number: latest.number,
    semver: latest.semver,
    hash: '',
    message: `Pulled from ${remoteName}`,
    schemas: schemaMap,
    records: allHashes,
    files: [],
    createdAt: new Date().toISOString(),
  }

  writeVersion(root, versionManifest)
  setHead(root, latest.number)
  console.log(
    `Version ${latest.number} (${latest.semver}): ${allHashes.length} records, ${Object.keys(schemaMap).length} types`,
  )
}
