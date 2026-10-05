/**
 * GET /api/collections/:owner/:slug/export?version=&format=tar|tar.gz
 *
 * A tar archive of what the caller may read (v1 layout, plus README.md):
 *   manifest.json             collection, version, schemas, missing and withheld files
 *   README.md                 the version's metadata.readme, when there is one
 *   records/<Type>.ndjson     one {id,type,data,hash} per line
 *   files/<hash>              file bytes
 *
 * Streams with no record count limit: tar needs sizes up front, and the trees
 * give them without reading records (a type's NDJSON is its canonical bytes plus
 * a fixed `,"hash":"…"` and newline per record). gzip costs Worker CPU per byte,
 * so very large exports should ask for format=tar.
 *
 * Denylisted hashes are left out: records are withheld (when any are blocked, a
 * pass over each type's tree nodes, not its bodies, gives the exact sizes), and
 * files are listed as withheld instead of sent.
 */
import { fileTree, iterate, RepoSource, type TarEntry, tarStream } from '@underlay/protocol'
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { deniedHashes } from '../lib/limits.js'
import { findVersion, loadView, typeRecords } from '../versions/view.js'
import { jsonError, requireCollection } from './access.js'

const enc = new TextEncoder()
// `{"id":…}` → `{"id":…,"hash":"<64 hex>"}` adds 74 bytes; plus the newline.
const PER_RECORD_EXTRA = 75

export function exportRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/:owner/:slug/export', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const format = c.req.query('format') ?? 'tar.gz'
    if (format !== 'tar' && format !== 'tar.gz')
      return jsonError(c, 400, `Unknown format "${format.slice(0, 40)}": use tar or tar.gz`)
    const ports = c.var.ports
    const v = await findVersion(
      ports.db,
      access.collection.id,
      c.req.query('version') ?? 'latest',
      access.collection.headVersionId,
    )
    if (!v) return jsonError(c, 404, 'No versions found')
    const repo = await ports.stores.forCollection(access.collection.id)
    const denied = await deniedHashes(c.var.ports.db)
    const view = await loadView(repo, v, access.isMember, denied)
    const gzip = format === 'tar.gz'

    // Each type's NDJSON size and count, from its tree totals unless records are withheld.
    const sizes = new Map<string, { count: number; bytes: number }>()
    for (const t of view.types) {
      if (denied.size === 0) {
        sizes.set(t.slug, { count: t.count, bytes: t.bytes + t.count * PER_RECORD_EXTRA })
        continue
      }
      const s = { count: 0, bytes: 0 }
      for await (const e of typeRecords(view, t)) {
        s.count++
        s.bytes += e.size + PER_RECORD_EXTRA
      }
      sizes.set(t.slug, s)
    }

    // Files the caller may read, and which of them the platform has bytes for.
    const fileSource = new RepoSource(fileTree, repo)
    const fileHashes = new Map<string, number>()
    for (const r of [view.public.files.root, view.private?.files.root ?? null]) {
      for await (const f of iterate(fileSource, r)) fileHashes.set(f.key, f.size)
    }
    const withheldFiles = [...fileHashes.keys()].filter((h) => denied.has(h))
    for (const h of withheldFiles) fileHashes.delete(h)
    const rows: (typeof schema.files.$inferSelect)[] = []
    const list = [...fileHashes.keys()]
    for (const part of chunks(list, JSON_CHUNK)) {
      rows.push(
        ...(await ports.db.select().from(schema.files).where(inJson(schema.files.hash, part))),
      )
    }
    const stored = new Map(rows.map((r) => [r.hash, r]))

    const schemas: Record<string, unknown> = {}
    for (const t of view.types) schemas[t.slug] = await repo.schema(t.schemaHash)
    const recordCount = [...sizes.values()].reduce((n, s) => n + s.count, 0)
    const manifest = enc.encode(
      JSON.stringify(
        {
          collection: {
            owner: access.owner.slug,
            slug: access.collection.slug,
            name: access.collection.name,
            description: access.collection.summary?.description ?? null,
          },
          version: {
            semver: v.semver,
            hash: v.hash,
            message: v.message,
            recordCount,
            fileCount: fileHashes.size,
            totalBytes:
              [...sizes.values()].reduce((n, s) => n + s.bytes - s.count * PER_RECORD_EXTRA, 0) +
              [...fileHashes.values()].reduce((a, b) => a + b, 0),
            createdAt: v.createdAt,
          },
          schemas,
          files_missing: list.filter((h) => !stored.has(h)),
          files_withheld: withheldFiles,
        },
        null,
        2,
      ),
    )
    const readme =
      typeof view.root.metadata?.readme === 'string' ? enc.encode(view.root.metadata.readme) : null

    const entries = async function* (): AsyncGenerator<TarEntry> {
      yield {
        name: 'manifest.json',
        size: manifest.byteLength,
        body: async function* () {
          yield manifest
        },
      }
      if (readme)
        yield {
          name: 'README.md',
          size: readme.byteLength,
          body: async function* () {
            yield readme
          },
        }
      for (const t of view.types) {
        yield {
          name: `records/${t.slug}.ndjson`,
          size: sizes.get(t.slug)!.bytes,
          body: async function* () {
            let batch: string[] = []
            for await (const e of typeRecords(view, t, { bodies: true })) {
              batch.push(`${e.body!.slice(0, -1)},"hash":"${e.hash}"}\n`)
              if (batch.length === 512) {
                yield enc.encode(batch.join(''))
                batch = []
              }
            }
            if (batch.length) yield enc.encode(batch.join(''))
          },
        }
      }
      for (const [hash, size] of fileHashes) {
        const f = stored.get(hash)
        if (!f) continue
        yield {
          name: `files/${hash}`,
          size,
          body: async function* () {
            const obj = await ports.stores.fileBytes.get(f.storageKey)
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

    // Entries are dated when the version was made, so a version exports to the
    // same bytes every time (gzip's header carries no time: CompressionStream
    // writes 0).
    let body = tarStream(entries(), v.createdAt.getTime())
    if (gzip)
      body = body.pipeThrough(
        new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
      )
    const name = `${access.owner.slug}-${access.collection.slug}-${v.semver}.tar${gzip ? '.gz' : ''}`
    return new Response(body, {
      headers: {
        'content-type': gzip ? 'application/gzip' : 'application/x-tar',
        'content-disposition': `attachment; filename="${name}"`,
      },
    })
  })

  return app
}
