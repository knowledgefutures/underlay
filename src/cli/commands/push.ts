import { readConfig } from '../lib/config.js'
import { requireRoot, getHead, readVersion, readObject, readSchema } from '../lib/store.js'

const RECORDS_BATCH_SIZE = 5000

export async function push(remoteName: string = 'origin'): Promise<void> {
  const root = requireRoot()
  const config = readConfig(root)
  const remote = config.remotes[remoteName]

  if (!remote) {
    console.error(`Remote "${remoteName}" not found. Use \`underlay remote add\` first.`)
    process.exit(1)
  }
  if (!remote.token) {
    console.error(`Remote "${remoteName}" has no token. Set one with \`underlay remote add\`.`)
    process.exit(1)
  }
  if (!remote.collection) {
    console.error(
      `Remote "${remoteName}" has no collection. Set one with \`underlay remote add --collection owner/slug\`.`,
    )
    process.exit(1)
  }

  const head = getHead(root)
  if (!head) {
    console.error('No versions to push.')
    process.exit(1)
  }

  const version = readVersion(root, head)
  if (!version) {
    console.error(`Version ${head} not found.`)
    process.exit(1)
  }

  const baseUrl = `${remote.url}/api/collections/${remote.collection}`
  const headers = {
    Authorization: `Bearer ${remote.token}`,
  }

  // 1. Get remote latest version
  let remoteLatestSemver: string | null = null
  try {
    const res = await fetch(`${baseUrl}/versions/latest`)
    if (res.ok) {
      const data = (await res.json()) as { semver: string }
      remoteLatestSemver = data.semver
    }
  } catch {
    // no remote versions yet
  }

  // 2. Build schemas map
  const schemas: Record<string, unknown> = {}
  for (const [slug, hash] of Object.entries(version.schemas)) {
    const body = readSchema(root, hash)
    if (body) schemas[slug] = JSON.parse(body)
  }

  // 3. Build manifest
  const manifest = version.records
    .map((hash) => {
      const obj = readObject(root, hash)
      if (!obj) return null
      const rec = JSON.parse(obj) as { id: string; type: string }
      return { id: rec.id, type: rec.type, hash }
    })
    .filter(Boolean)

  console.log(`Negotiating with ${remote.url}...`)

  // 4. Negotiate
  const negotiateRes = await fetch(`${baseUrl}/versions/negotiate`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_version: remoteLatestSemver,
      schemas,
      manifest,
      files: version.files,
      message: version.message,
      metadata: version.metadata,
    }),
  })

  if (!negotiateRes.ok) {
    const err = await negotiateRes.text()
    console.error(`Negotiate failed (${negotiateRes.status}): ${err}`)
    process.exit(1)
  }

  const negotiateData = (await negotiateRes.json()) as {
    session_id: string
    needed_records: string[]
    needed_files: string[]
  }

  console.log(
    `Server needs ${negotiateData.needed_records.length} of ${version.records.length} records`,
  )

  // 5. Send needed records in batches via /records
  if (negotiateData.needed_records.length > 0) {
    const neededSet = new Set(negotiateData.needed_records)
    const neededHashes = version.records.filter((h) => neededSet.has(h))

    for (let i = 0; i < neededHashes.length; i += RECORDS_BATCH_SIZE) {
      const batch = neededHashes.slice(i, i + RECORDS_BATCH_SIZE)
      const lines: string[] = []
      for (const hash of batch) {
        const obj = readObject(root, hash)
        if (obj) lines.push(obj)
      }

      const batchNum = Math.floor(i / RECORDS_BATCH_SIZE) + 1
      const totalBatches = Math.ceil(neededHashes.length / RECORDS_BATCH_SIZE)

      const recordsRes = await fetch(
        `${baseUrl}/versions/negotiate/${negotiateData.session_id}/records`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/x-ndjson' },
          body: lines.join('\n'),
        },
      )

      if (!recordsRes.ok) {
        const err = await recordsRes.text()
        console.error(`Records batch failed (${recordsRes.status}): ${err}`)
        process.exit(1)
      }

      const batchResult = (await recordsRes.json()) as {
        received: number
        remaining: number
      }

      if (totalBatches > 1) {
        console.log(
          `Batch ${batchNum}/${totalBatches}: sent ${batchResult.received}, ${batchResult.remaining} remaining`,
        )
      }
    }
  }

  // 6. Commit
  const commitRes = await fetch(
    `${baseUrl}/versions/negotiate/${negotiateData.session_id}/commit`,
    {
      method: 'POST',
      headers,
    },
  )

  if (!commitRes.ok) {
    const err = await commitRes.text()
    console.error(`Commit failed (${commitRes.status}): ${err}`)
    process.exit(1)
  }

  const result = (await commitRes.json()) as { semver: string }
  console.log(`Pushed ${result.semver} to ${remoteName}`)
}
