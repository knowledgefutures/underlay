import { hashRecord, hashSchema } from '../../lib/core/index.js'
import { readConfig } from '../lib/config.js'
import {
  requireRoot,
  getHead,
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
  const headers = remote.token ? { Authorization: `Bearer ${remote.token}` } : {}
  const head = getHead(root)

  // 1. Get remote latest (includes full schema bodies and metadata)
  const latestRes = await fetch(`${baseUrl}/versions/latest`, { headers })
  if (!latestRes.ok) {
    console.error(`Failed to fetch latest version (${latestRes.status})`)
    process.exit(1)
  }

  const latest = (await latestRes.json()) as {
    semver: string
    hash: string
    message: string
    metadata: Record<string, unknown> | null
    schemas: Record<string, unknown>
  }
  if (latest.semver === head) {
    console.log(`Already up to date (${head})`)
    return
  }

  console.log(`Pulling ${latest.semver}...`)

  // 2. Store schemas from the latest response (has full bodies)
  const schemaMap: Record<string, string> = {}
  for (const [slug, body] of Object.entries(latest.schemas)) {
    const hash = hashSchema(body)
    writeSchema(root, hash, JSON.stringify(body))
    schemaMap[slug] = hash
  }

  // 3. Get manifest for record hashes
  const manifestUrl = head
    ? `${baseUrl}/versions/${latest.semver}/manifest?since=${head}`
    : `${baseUrl}/versions/${latest.semver}/manifest`

  const manifestRes = await fetch(manifestUrl, { headers })
  if (!manifestRes.ok) {
    console.error(`Failed to fetch manifest (${manifestRes.status})`)
    process.exit(1)
  }

  const manifest = (await manifestRes.json()) as {
    records: Array<{ id: string; type: string; hash: string }>
    files: string[]
  }

  // 4. Figure out which record hashes we need
  const allHashes = manifest.records.map((r) => r.hash)
  const needed = allHashes.filter((h) => !hasObject(root, h))

  if (needed.length > 0) {
    console.log(`Fetching ${needed.length} of ${allHashes.length} records...`)

    const batchRes = await fetch(`${remote.url}/api/records/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
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
    semver: latest.semver,
    hash: latest.hash,
    message: latest.message ?? `Pulled from ${remoteName}`,
    metadata: latest.metadata ?? null,
    schemas: schemaMap,
    records: allHashes,
    files: manifest.files ?? [],
    createdAt: new Date().toISOString(),
  }

  writeVersion(root, versionManifest)
  setHead(root, latest.semver)
  console.log(
    `${latest.semver}: ${allHashes.length} records, ${Object.keys(schemaMap).length} types`,
  )
}
