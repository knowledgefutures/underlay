/**
 * GET /api/collections/:owner/:slug/export?version=&format=tar|tar.gz
 *
 * A tar archive of what the caller may read (v1 layout, plus README.md):
 *   manifest.json             collection, version, schemas, missing files
 *   README.md                 the version's metadata.readme, when there is one
 *   records/<Type>.ndjson     one {id,type,data,hash} per line
 *   files/<hash>              file bytes
 *
 * Streams with no record count limit: tar needs sizes up front, and the trees
 * give them without reading records (a type's NDJSON is its canonical bytes plus
 * a fixed `,"hash":"…"` and newline per record). gzip costs Worker CPU per byte,
 * so very large exports should ask for format=tar.
 */
import { fileTree, iterate, RepoSource } from '@underlay/protocol'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { type TarEntry, tarStream } from '../lib/tar.js'
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
    const ports = c.var.ports
    const v = await findVersion(
      ports.db,
      access.collection.id,
      c.req.query('version') ?? 'latest',
      access.collection.headVersionId,
    )
    if (!v) return jsonError(c, 404, 'No versions found')
    const repo = await ports.stores.forCollection(access.collection.id)
    const view = await loadView(repo, v, access.isMember)
    const gzip = c.req.query('format') !== 'tar'

    // Files the caller may read, and which of them the platform has bytes for.
    const fileSource = new RepoSource(fileTree, repo)
    const fileHashes = new Map<string, number>()
    for (const r of [view.public.files.root, view.private?.files.root ?? null]) {
      for await (const f of iterate(fileSource, r)) fileHashes.set(f.key, f.size)
    }
    const rows: (typeof schema.files.$inferSelect)[] = []
    const list = [...fileHashes.keys()]
    for (let i = 0; i < list.length; i += 90) {
      rows.push(
        ...(await ports.db
          .select()
          .from(schema.files)
          .where(inArray(schema.files.hash, list.slice(i, i + 90)))),
      )
    }
    const stored = new Map(rows.map((r) => [r.hash, r]))

    const schemas: Record<string, unknown> = {}
    for (const t of view.types) schemas[t.slug] = await repo.schema(t.schemaHash)
    const recordCount = view.types.reduce((n, t) => n + t.count, 0)
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
              view.types.reduce((n, t) => n + t.bytes, 0) +
              [...fileHashes.values()].reduce((a, b) => a + b, 0),
            createdAt: v.createdAt,
          },
          schemas,
          files_missing: list.filter((h) => !stored.has(h)),
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
          size: t.bytes + t.count * PER_RECORD_EXTRA,
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

    let body = tarStream(entries())
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
