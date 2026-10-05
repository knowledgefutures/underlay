/**
 * The converter against a real v1 schema: PGlite (Postgres in WASM) runs v1's
 * own migrations, a fixture collection is written the way v1 stores it, and the
 * result is checked through the v2 API.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { hashRecord, hashSchema, sha256Hex, verifyLog } from '@underlay/protocol'
import { dbSchema } from '@underlay/server'
import { afterAll, describe, expect, it } from 'vitest'

import { cleanup, harness } from '../../server/test/harness.js'
import { migrateAll, migrateConfig, type V1Db } from '../src/convert.js'

afterAll(cleanup)

/** v1's own migrations (from main at 7f6e1c6), the schema the converter reads. */
const v1Schema = join(import.meta.dirname, 'v1-schema')

/** v1 in PGlite; with `cursors`, ordered reads use server-side cursors fetched a row at a time. */
async function v1Database(
  cursors = false,
): Promise<{ pg: PGlite; db: V1Db & { recordReads: number } }> {
  const pg = new PGlite()
  const journal = JSON.parse(await readFile(join(v1Schema, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[]
  }
  for (const { tag } of journal.entries) {
    const sql = await readFile(join(v1Schema, `${tag}.sql`), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
  }
  let open = 0
  let seq = 0
  const db: V1Db & { recordReads: number } = {
    recordReads: 0,
    query: async (text, params) => (await pg.query(text, params ?? [])).rows as never,
    ...(cursors && {
      cursor: async (text: string, params: unknown[]) => {
        if (text.includes('JOIN record_objects')) db.recordReads++
        if (open++ === 0) await pg.query('BEGIN')
        const name = `c${++seq}`
        await pg.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${text}`, params)
        return {
          next: async () => (await pg.query(`FETCH 1 FROM ${name}`)).rows as never,
          close: async () => {
            await pg.query(`CLOSE ${name}`)
            if (--open === 0) await pg.query('COMMIT')
          },
        }
      },
    }),
  }
  return { pg, db }
}

const Author = {
  type: 'object',
  properties: { name: { type: 'string' }, scores: { type: 'object' }, photo: {} },
}
const FILE = 'f'.repeat(64)

describe('v1 → v2 migration', () => {
  it.each([
    ['keyset pages', false],
    ['cursors', true],
  ])(
    'replays a collection history with its privacy and files, re-hashed (%s)',
    async (_, cursors) => {
      const { pg, db } = await v1Database(cursors)
      const q = (s: string, p: unknown[] = []) => pg.query(s, p)
      await q(`INSERT INTO "user" (id, name, email) VALUES ('u1', 'Ada', 'ada@example.org')`)
      await q(`INSERT INTO organization (id, name, slug) VALUES ('o1', 'Org', 'org')`)
      await q(
        `INSERT INTO member (id, organization_id, user_id, role) VALUES ('m1', 'o1', 'u1', 'owner')`,
      )
      await q(
        `INSERT INTO collections (id, organization_id, slug, name, public) VALUES ('11111111-1111-1111-1111-111111111111', 'o1', 'lib', 'Lib', true)`,
      )
      await q(
        `INSERT INTO files (hash, size, mime_type, storage_key) VALUES ($1, 3, 'image/png', 'files/ff/ff/legacy')`,
        [FILE],
      )
      const s = await q(`INSERT INTO schemas (schema, schema_hash) VALUES ($1, $2) RETURNING id`, [
        Author,
        hashSchema(Author),
      ])
      const schemaId = (s.rows[0] as { id: string }).id

      const records = {
        a1: { id: 'a', data: { name: 'A', photo: { $file: `sha256:${FILE}` } } },
        a2: { id: 'a', data: { name: 'A2', photo: { $file: `sha256:${FILE}` } } },
        b: { id: 'b', data: { name: 'B', scores: { 10: 1, 9: 2 } } }, // integer-like keys: re-hashed
        c: { id: 'c', data: { name: 'C' } },
        // v1 let a version hold an id twice; the newer record object wins.
        cOld: { id: 'c', data: { name: 'C, older' } },
      }
      // v1's own record hashes: the converter re-hashes, so any unique value will do.
      const v1hash = (r: { id: string; data: unknown }) =>
        sha256Hex(JSON.stringify({ v1: [r.id, r.data] }))
      for (const r of Object.values(records)) {
        await q(
          `INSERT INTO record_objects (hash, record_id, type, data, size, created_at) VALUES ($1, $2, 'Author', $3, 10, $4) ON CONFLICT DO NOTHING`,
          [
            v1hash(r),
            r.id,
            r.data,
            r === records.cOld ? '2020-01-01T00:00:00Z' : '2025-01-01T00:00:00Z',
          ],
        )
      }
      const version = async (
        semver: string,
        members: [{ id: string; data: unknown }, boolean][],
        extra: { recordsFrom?: number; metadata?: object; at: string },
      ) => {
        const [maj, min, pat] = semver.slice(1).split('.').map(Number)
        const v = await q(
          `INSERT INTO versions (collection_id, semver, major, minor, patch, hash, public_hash, metadata, record_count, file_count, total_bytes, records_from_version_id, status, created_at)
         VALUES ('11111111-1111-1111-1111-111111111111', $1, $2, $3, $4, $5, $6, $7, $8, 1, 0, $9, 'ready', $10) RETURNING id`,
          [
            semver,
            maj,
            min,
            pat,
            `private:${semver}`,
            `public:${semver}`,
            extra.metadata ?? null,
            members.length,
            extra.recordsFrom ?? null,
            extra.at,
          ],
        )
        const id = (v.rows[0] as { id: number }).id
        await q(
          `INSERT INTO version_schemas (version_id, slug, schema_id) VALUES ($1, 'Author', $2)`,
          [id, schemaId],
        )
        await q(`INSERT INTO version_files (version_id, file_hash) VALUES ($1, $2)`, [id, FILE])
        for (const [r, priv] of members) {
          await q(
            `INSERT INTO version_records (version_id, record_hash, record_id, type, private) VALUES ($1, $2, $3, 'Author', $4)`,
            [id, v1hash(r), r.id, priv],
          )
        }
        return id
      }
      await version(
        'v1.0.0',
        [
          [records.a1, false],
          [records.b, false],
          [records.c, true],
          [records.cOld, true],
        ],
        { metadata: { title: 'Lib' }, at: '2026-01-01T00:00:00Z' },
      )
      const v11 = await version(
        'v1.1.0',
        [
          [records.a2, false],
          [records.b, true],
        ],
        { metadata: { title: 'Lib' }, at: '2026-02-01T00:00:00Z' },
      )
      await version('v1.1.1', [], {
        recordsFrom: v11,
        metadata: { title: 'Lib', readme: 'hi' },
        at: '2026-03-01T00:00:00Z',
      })

      const h = await harness()
      // With cursors, also hold private changes on disk from the first one.
      migrateConfig.holdInMemory = cursors ? 1 : 50_000
      const report = await migrateAll(db, h.ports)
      migrateConfig.holdInMemory = 50_000
      // Each type is read once per version with changes, not once per set:
      // v1.0.0 and v1.1.0 (v1.1.1 shares v1.1.0's records).
      if (cursors) expect(db.recordReads).toBe(2)
      await h.drain()
      expect(report).toMatchObject({
        collections: 1,
        versions: 3,
        skippedVersions: [],
        fieldPrivateTypes: [],
        duplicateIds: [
          {
            collection: 'lib',
            semver: 'v1.0.0',
            type: 'Author',
            id: 'c',
            hash: v1hash(records.cOld),
          },
        ],
      })

      const json = async (path: string, user?: string) =>
        (await (await h.request(path, user ? { user } : {})).json()) as any
      // Proof of possession for every file the collection's versions held.
      expect(await h.ports.db.select().from(dbSchema.fileUploads)).toMatchObject([
        { collectionId: '11111111-1111-1111-1111-111111111111', hash: FILE, status: 'verified' },
      ])
      // A run limited to named collections refuses a name it can't find.
      await expect(
        migrateAll(db, (await harness()).ports, { collections: ['org/nope'] }),
      ).rejects.toThrow('No v1 collection: org/nope')
      const [lib] = await h.ports.db.select().from(dbSchema.collections)
      const v1Updated = (await pg.query(`SELECT updated_at FROM collections`)).rows[0] as {
        updated_at: Date
      }
      expect(lib!.updatedAt.getTime()).toBe(v1Updated.updated_at.getTime())
      const versions = await json('/api/collections/org/lib/versions', 'u1')
      const first = await json('/api/collections/org/lib/versions/v1.0.0/records?type=Author', 'u1')
      expect(first.records.find((r: any) => r.id === 'c').data).toEqual({ name: 'C' })
      expect(versions.map((v: any) => v.semver)).toEqual(['v1.1.1', 'v1.1.0', 'v1.0.0'])
      expect(versions.map((v: any) => v.recordCount)).toEqual([2, 2, 3])
      // Anonymous readers see only the public set: b went private in v1.1.0.
      const pub = await json('/api/collections/org/lib/versions/v1.1.1/records')
      expect(pub.records.map((r: any) => r.id)).toEqual(['a'])
      const latest = await json('/api/collections/org/lib/versions/latest', 'u1')
      expect(latest.metadata).toEqual({ title: 'Lib', readme: 'hi' })
      // The file kept its v1 storage key and is downloadable.
      const file = await h.request(`/api/collections/org/lib/files/${FILE}`)
      expect(file.status).toBe(302)
      expect(file.headers.get('location')).toContain('files/ff/ff/legacy')
      // Provenance by b's v2 hash (members only now); its v1 hash is gone.
      const bHash = hashRecord('b', 'Author', records.b.data).hash
      const prov = await json(`/api/records/${bHash}/provenance`, 'u1')
      expect(prov.recordHash).toBe(bHash)
      expect(
        (await h.request(`/api/records/${v1hash(records.b)}/provenance`, { user: 'u1' })).status,
      ).toBe(404)
      expect(prov.references.map((r: any) => r.semver)).toEqual(['v1.0.0', 'v1.1.0', 'v1.1.1'])
      // The signed log over the replayed history; v1 version hashes don't resolve.
      const repo = await h.ports.stores.forCollection('11111111-1111-1111-1111-111111111111')
      const { entries } = await verifyLog(repo, '11111111-1111-1111-1111-111111111111', [
        h.signer.publicKey,
      ])
      expect(entries.map((e) => [e.semver, e.createdAt.slice(0, 10)])).toEqual([
        ['v1.0.0', '2026-01-01'],
        ['v1.1.0', '2026-02-01'],
        ['v1.1.1', '2026-03-01'],
      ])
      expect(
        (await h.request('/api/collections/org/lib/versions/private:v1.1.0', { user: 'u1' }))
          .status,
      ).toBe(404)
    },
  )
})

describe('v1 → v2 sync', () => {
  it('replays only newer versions and mirrors account rows', async () => {
    const { pg, db } = await v1Database(true)
    const q = (s: string, p: unknown[] = []) => pg.query(s, p)
    const COL = '22222222-2222-2222-2222-222222222222'
    await q(`INSERT INTO "user" (id, name, email) VALUES ('u1', 'Ada', 'ada@example.org')`)
    await q(`INSERT INTO "user" (id, name, email) VALUES ('u2', 'Bo', 'bo@example.org')`)
    await q(`INSERT INTO organization (id, name, slug) VALUES ('o1', 'Org', 'org')`)
    await q(
      `INSERT INTO member (id, organization_id, user_id, role) VALUES ('m1', 'o1', 'u1', 'owner')`,
    )
    await q(
      `INSERT INTO collections (id, organization_id, slug, name, public) VALUES ($1, 'o1', 'lib', 'Lib', true)`,
      [COL],
    )
    const s = await q(`INSERT INTO schemas (schema, schema_hash) VALUES ($1, $2) RETURNING id`, [
      Author,
      hashSchema(Author),
    ])
    const schemaId = (s.rows[0] as { id: string }).id
    const record = async (id: string, name: string) => {
      const hash = sha256Hex(`v1:${id}:${name}`)
      await q(
        `INSERT INTO record_objects (hash, record_id, type, data, size) VALUES ($1, $2, 'Author', $3, 10)`,
        [hash, id, { name }],
      )
      return { id, hash }
    }
    const version = async (semver: string, members: { id: string; hash: string }[], at: string) => {
      const [maj, min, pat] = semver.slice(1).split('.').map(Number)
      const v = await q(
        `INSERT INTO versions (collection_id, semver, major, minor, patch, hash, public_hash, record_count, file_count, total_bytes, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 'ready', $9) RETURNING id`,
        [COL, semver, maj, min, pat, `private:${semver}`, `public:${semver}`, members.length, at],
      )
      const id = (v.rows[0] as { id: number }).id
      await q(
        `INSERT INTO version_schemas (version_id, slug, schema_id) VALUES ($1, 'Author', $2)`,
        [id, schemaId],
      )
      for (const r of members) {
        await q(
          `INSERT INTO version_records (version_id, record_hash, record_id, type, private) VALUES ($1, $2, $3, 'Author', false)`,
          [id, r.hash, r.id],
        )
      }
    }
    const a = await record('a', 'A')
    await version('v1.0.0', [a], '2026-01-01T00:00:00Z')

    const h = await harness()
    const first = await migrateAll(db, h.ports)
    await h.drain()
    expect(first.versions).toBe(1)

    // v1 moves on: a new version, a renamed collection, a deleted user.
    const b = await record('b', 'B')
    await version('v1.1.0', [a, b], '2026-02-01T00:00:00Z')
    await q(`UPDATE collections SET name = 'Lib 2' WHERE id = $1`, [COL])
    await q(`DELETE FROM "user" WHERE id = 'u2'`)

    const second = await migrateAll(db, h.ports, { sync: true })
    await h.drain()
    expect(second).toMatchObject({ versions: 1, deleted: { user: 1 }, removedInV1: [] })
    const users = await h.ports.db.select().from(dbSchema.user)
    expect(users.map((u) => u.id)).toEqual(['u1'])
    const [lib] = await h.ports.db.select().from(dbSchema.collections)
    expect(lib!.name).toBe('Lib 2')
    const versions = (await (
      await h.request('/api/collections/org/lib/versions', { user: 'u1' })
    ).json()) as { semver: string; recordCount: number }[]
    expect(versions.map((v) => [v.semver, v.recordCount])).toEqual([
      ['v1.1.0', 2],
      ['v1.0.0', 1],
    ])
    const repo = await h.ports.stores.forCollection(COL)
    const { entries } = await verifyLog(repo, COL, [h.signer.publicKey])
    expect(entries.map((e) => e.semver)).toEqual(['v1.0.0', 'v1.1.0'])

    // Nothing new: nothing replayed, nothing deleted.
    const third = await migrateAll(db, h.ports, { sync: true })
    expect(third).toMatchObject({ versions: 0, deleted: {} })
  })
})
