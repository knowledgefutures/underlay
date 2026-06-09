import { hashRecord, hashSchema } from '../../lib/core/index.js'
import { readConfig } from '../lib/config.js'
import { parseJsonOrExit } from '../lib/json.js'
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

const BATCH_CHUNK_SIZE = 5000

type ManifestRecord = { id: string; type: string; hash: string }

type FullManifestPage = {
  records: ManifestRecord[]
  files: string[]
  pagination: { hasMore: boolean; nextCursor: string | null }
}

type DeltaManifest = {
  schemas: Record<string, string>
  delta: {
    added: ManifestRecord[]
    updated: Array<ManifestRecord & { previousHash: string }>
    removed: ManifestRecord[]
  }
  files: string[]
  truncated: boolean
}

async function fetchFullManifest(
  baseUrl: string,
  semver: string,
  headers: Record<string, string>,
): Promise<{ recordHashes: string[]; files: string[] }> {
  const recordHashes: string[] = []
  let files: string[] = []
  let cursor: string | null = null

  do {
    const url: string = cursor
      ? `${baseUrl}/versions/${semver}/manifest?cursor=${encodeURIComponent(cursor)}`
      : `${baseUrl}/versions/${semver}/manifest`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      console.error(`Failed to fetch manifest (${res.status})`)
      process.exit(1)
    }
    const page = (await res.json()) as FullManifestPage
    for (const r of page.records) recordHashes.push(r.hash)
    files = page.files ?? []
    cursor = page.pagination?.hasMore ? page.pagination.nextCursor : null
  } while (cursor)

  return { recordHashes, files }
}

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
  const headers: Record<string, string> = remote.token
    ? { Authorization: `Bearer ${remote.token}` }
    : {}
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

  // 3. Get the record set: delta against local HEAD when possible, full manifest otherwise
  const prev = head ? readVersion(root, head) : null
  let allHashes: string[]
  let files: string[]

  if (head && prev) {
    const deltaRes = await fetch(
      `${baseUrl}/versions/${latest.semver}/manifest?since=${encodeURIComponent(head)}`,
      { headers },
    )
    if (!deltaRes.ok) {
      console.error(`Failed to fetch manifest (${deltaRes.status})`)
      process.exit(1)
    }
    const delta = (await deltaRes.json()) as DeltaManifest

    if (delta.truncated) {
      // Delta has no resume cursor server-side; fall back to the full manifest.
      const full = await fetchFullManifest(baseUrl, latest.semver, headers)
      allHashes = full.recordHashes
      files = full.files
    } else {
      const hashes = new Set(prev.records)
      for (const r of delta.delta.removed) hashes.delete(r.hash)
      for (const r of delta.delta.updated) {
        hashes.delete(r.previousHash)
        hashes.add(r.hash)
      }
      for (const r of delta.delta.added) hashes.add(r.hash)
      allHashes = [...hashes]
      files = delta.files ?? []
    }
  } else {
    const full = await fetchFullManifest(baseUrl, latest.semver, headers)
    allHashes = full.recordHashes
    files = full.files
  }

  // 4. Fetch the record objects we don't have yet, in chunks, streaming each response
  const needed = allHashes.filter((h) => !hasObject(root, h))

  if (needed.length > 0) {
    console.log(`Fetching ${needed.length} of ${allHashes.length} records...`)

    const received = new Set<string>()
    const storeLine = (line: string): void => {
      const rec = parseJsonOrExit<{ id: string; type: string; data: unknown; hash?: string }>(
        line,
        'a record line in the server batch response',
        'The server response was malformed; local version and HEAD were not updated. Retry the pull.',
      )
      const { hash, canonical } = hashRecord(rec)
      writeObject(root, hash, canonical)
      received.add(rec.hash ?? hash)
    }

    for (let i = 0; i < needed.length; i += BATCH_CHUNK_SIZE) {
      const chunk = needed.slice(i, i + BATCH_CHUNK_SIZE)
      const batchRes = await fetch(`${remote.url}/api/records/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ hashes: chunk }),
      })

      if (!batchRes.ok || !batchRes.body) {
        const err = await batchRes.text().catch(() => '')
        console.error(`Records batch failed (${batchRes.status}): ${err}`)
        console.error('Aborting pull; local version and HEAD not updated.')
        process.exit(1)
      }

      const reader = batchRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) storeLine(line)
          newline = buffer.indexOf('\n')
        }
      }
      const tail = (buffer + decoder.decode()).trim()
      if (tail) storeLine(tail)
    }

    const missing = needed.filter((h) => !received.has(h))
    if (missing.length > 0) {
      console.error(
        `Remote did not return ${missing.length} of ${needed.length} requested records (first missing: ${missing[0]}).`,
      )
      console.error('Aborting pull; local version and HEAD not updated.')
      process.exit(1)
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
    files,
    createdAt: new Date().toISOString(),
  }

  writeVersion(root, versionManifest)
  setHead(root, latest.semver)
  console.log(
    `${latest.semver}: ${allHashes.length} records, ${Object.keys(schemaMap).length} types`,
  )
}
