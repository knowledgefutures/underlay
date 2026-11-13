/**
 * The export of a v3 collection (api/export.ts has the format): a tar of manifest.json,
 * README.md, records/<Type>.ndjson, and files/<hash>, the same entries v2's export has.
 *
 * Tar needs each entry's size up front: a type's NDJSON is its lines plus a fixed
 * `,"hash":"…"` and newline per record, so one pass over the key entries (no lines) gives
 * them, blocked records left out. Files are the version's assets; blocked ones are listed
 * as withheld, and any whose bytes are not stored as missing.
 */
import { tarStream, type TarEntry, v3 } from '@underlay/protocol'
import type { Context } from 'hono'

import type { CollectionAccess } from '../api/access.js'
import type { AppEnv } from '../app.js'
import { deniedHashes } from '../lib/limits.js'
import { assetsOf, metadataOf, schemasOf } from './catalog.js'
import { liveRecords, v3VersionFor, withHash } from './reads.js'
import { assetKey } from './rules.js'

const enc = new TextEncoder()
// `{"id":…}` → `{"id":…,"hash":"<64 hex>"}` adds 74 bytes; plus the newline.
const PER_RECORD_EXTRA = 75
const READ_AHEAD = 4 * 1024 * 1024

export async function v3Export(
  c: Context<AppEnv>,
  access: CollectionAccess,
  q: { version: string; gzip: boolean },
): Promise<Response> {
  const v = await v3VersionFor(c, access, q.version)
  if (v instanceof Response) return v
  const store = c.var.ports.stores.v3
  const view = v.view

  // Each type's records and NDJSON bytes, from key entries alone.
  const sizes = new Map<string, { count: number; bytes: number }>()
  for await (const w of liveRecords(c, view, {}, READ_AHEAD)) {
    let s = sizes.get(w.entry.type)
    if (!s) sizes.set(w.entry.type, (s = { count: 0, bytes: 0 }))
    s.count++
    s.bytes += w.entry.size + PER_RECORD_EXTRA
  }

  const denied = await deniedHashes(c.var.ports.db)
  const assets = await assetsOf(store, view)
  const withheld = [...assets.keys()].filter((h) => denied.has(h))
  for (const h of withheld) assets.delete(h)
  const present = await v3.inParallel(
    [...assets.keys()].map((h) => async () => (await store.head(assetKey(h))) !== null),
    16,
  )
  const files = [...assets].filter((_, i) => present[i])
  const missing = [...assets.keys()].filter((_, i) => !present[i])

  const metadata = await metadataOf(store, view)
  const manifest = enc.encode(
    JSON.stringify(
      {
        collection: {
          id: access.collection.id,
          owner: access.owner.slug,
          slug: access.collection.slug,
          name: access.collection.name,
          description: access.collection.summary?.description ?? null,
        },
        version: {
          semver: v.row.semver,
          hash: v.row.hash,
          message: v.row.message,
          recordCount: [...sizes.values()].reduce((n, s) => n + s.count, 0),
          fileCount: assets.size,
          totalBytes:
            [...sizes.values()].reduce((n, s) => n + s.bytes - s.count * PER_RECORD_EXTRA, 0) +
            [...assets.values()].reduce((n, a) => n + a.size, 0),
          createdAt: v.row.createdAt,
        },
        schemas: await schemasOf(store, view),
        files_missing: missing,
        files_withheld: withheld,
      },
      null,
      2,
    ),
  )
  const readme = typeof metadata?.readme === 'string' ? enc.encode(metadata.readme) : null

  const one = (bytes: Uint8Array) =>
    async function* () {
      yield bytes
    }
  const entries = async function* (): AsyncGenerator<TarEntry> {
    yield { name: 'manifest.json', size: manifest.byteLength, body: one(manifest) }
    if (readme) yield { name: 'README.md', size: readme.byteLength, body: one(readme) }
    for (const [type, s] of sizes) {
      yield {
        name: `records/${type}.ndjson`,
        size: s.bytes,
        body: async function* () {
          let batch: string[] = []
          for await (const w of liveRecords(c, view, { type }, READ_AHEAD)) {
            batch.push(withHash(await w.reader.line(w.entry), w.entry.hash!) + '\n')
            if (batch.length === 512) {
              yield enc.encode(batch.join(''))
              batch = []
            }
          }
          if (batch.length) yield enc.encode(batch.join(''))
        },
      }
    }
    for (const [hash, a] of files) {
      yield {
        name: `files/${hash}`,
        size: a.size,
        body: async function* () {
          const obj = await store.get(assetKey(hash))
          if (!obj) throw new Error(`File ${hash} is missing from storage`)
          const reader = obj.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return
            yield value
          }
        },
      }
    }
  }

  // Dated when the version was made, so a version exports to the same bytes every time.
  let body = tarStream(entries(), v.row.createdAt.getTime())
  if (q.gzip)
    body = body.pipeThrough(
      new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
    )
  const name = `${access.owner.slug}-${access.collection.slug}-${v.row.semver}.tar${q.gzip ? '.gz' : ''}`
  return new Response(body, {
    headers: {
      'content-type': q.gzip ? 'application/gzip' : 'application/x-tar',
      'content-disposition': `attachment; filename="${name}"`,
    },
  })
}
