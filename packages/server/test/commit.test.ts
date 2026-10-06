import {
  applyFileSet,
  type Change,
  compareUtf8,
  fileTree,
  getEntry,
  hashRecord,
  hashSchema,
  iterate,
  MissingFilesError,
  readHead,
  type RecordEntry,
  recordTree,
  Repo,
  RepoSource,
  tracksTypes,
  utf8ByteLength,
  verifyLog,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import * as schema from '../src/db/schema.js'
import { type BaseVersion, commitVersion, type TypeInput } from '../src/versions/commit.js'
import { publishVersion } from '../src/versions/publish.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const authorSchema = { type: 'object', properties: { name: { type: 'string' }, photo: {} } }
const secretSchema = { type: 'object', private: true, properties: { note: { type: 'string' } } }

const rec = (type: string, id: string, data: unknown): RecordEntry => {
  const { hash, canonical } = hashRecord(id, type, data)
  return { key: id, hash, size: utf8ByteLength(canonical), body: canonical }
}
const up = (type: string, id: string, data: unknown): Change<RecordEntry> => ({
  key: id,
  entry: rec(type, id, data),
})
const del = (id: string): Change<RecordEntry> => ({ key: id, entry: null })
const sorted = (cs: Change<RecordEntry>[]) => cs.sort((a, b) => compareUtf8(a.key, b.key))

const type = (
  slug: string,
  s: Record<string, unknown>,
  pub: Change<RecordEntry>[] | null,
  priv: Change<RecordEntry>[] | null = null,
): TypeInput => ({
  slug,
  schema: s,
  schemaHash: hashSchema(s),
  public: pub && sorted(pub),
  private: priv && sorted(priv),
})

const baseOf = (v: typeof schema.versions.$inferSelect): BaseVersion => ({
  id: v.id,
  seq: v.seq,
  semver: v.semver,
  hash: v.hash,
  publicRefsRoot: v.publicRefsRoot,
  privateRefsRoot: v.privateRefsRoot,
})

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const FILE = 'f'.repeat(64)

describe('commitVersion', () => {
  it('commits, publishes by CAS, and writes the signed log', async () => {
    const h = await harness()
    const c = await h.collection()
    const authors = Array.from({ length: 3000 }, (_, i) => up('Author', `a${i}`, { name: `A${i}` }))
    const r1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [type('Author', authorSchema, authors, [up('Author', 'hidden', { name: 'H' })])],
      metadata: { title: 'Test', tags: ['x'] },
      message: 'first',
    })
    expect(r1.status).toBe('committed')
    if (r1.status !== 'committed') return
    const v1 = r1.version
    expect(v1).toMatchObject({
      seq: 1,
      semver: 'v1.0.0',
      recordCount: 3001,
      publicRecordCount: 3000,
      hasPrivate: true,
    })
    expect(v1.hash).toMatch(/^ulv2:[0-9a-f]{64}$/)
    const [col] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(col!.headVersionId).toBe(v1.id)
    expect(col!.summary).toEqual({ title: 'Test', tags: ['x'] })

    const repo = await h.ports.stores.forCollection(c.id)
    const root = await repo.root(v1.hash)
    expect(root.public.types.Author!.count).toBe(3000)
    expect(root.private).toMatch(/^[0-9a-f]{64}$/)
    const priv = await repo.privateSet(root.private!)
    expect(priv.types.Author!.count).toBe(1)
    expect(priv.salt).toBe(c.privateSalt)
    // Public readers can't see the hidden record: it's not in the public tree.
    const source = new RepoSource(recordTree, repo)
    expect(await getEntry(source, root.public.types.Author!.root, 'hidden')).toBe(null)

    const { entries } = await verifyLog(repo, c.id, [h.signer.publicKey])
    expect(entries.map((e) => [e.seq, e.versionHash, e.message])).toEqual([[1, v1.hash, 'first']])

    // A small change: minor bump, O(changes) writes.
    const putsBefore = h.bucket.puts
    const r2 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v1),
      types: [
        type('Author', authorSchema, [
          up('Author', 'a5', { name: 'changed' }),
          del('a6'),
          up('Author', 'zz', { name: 'Z' }),
        ]),
      ],
      metadata: { title: 'Test', tags: ['x'] },
    })
    expect(r2.status).toBe('committed')
    if (r2.status !== 'committed') return
    expect(r2.version).toMatchObject({
      seq: 2,
      semver: 'v1.1.0',
      recordCount: 3001,
      changes: { added: 1, removed: 1, updated: 1 },
    })
    expect(h.bucket.puts - putsBefore).toBeLessThan(30)
    expect((await readHead(repo, c.id))!.seq).toBe(2)

    // The same content again: no change. A metadata edit: patch.
    const r3 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(r2.version),
      types: [type('Author', authorSchema, null)],
      metadata: { title: 'Test', tags: ['x'] },
    })
    expect(r3.status).toBe('no_changes')
    const r4 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(r2.version),
      types: [type('Author', authorSchema, null)],
      metadata: { title: 'Renamed' },
    })
    expect(r4.status === 'committed' && r4.version.semver).toBe('v1.1.1')
    if (r4.status !== 'committed') return
    const root4 = await repo.root(r4.version.hash)
    expect(root4.public).toEqual((await repo.root(r2.version.hash)).public)
    await expect(verifyLog(repo, c.id, [h.signer.publicKey])).resolves.toBeTruthy()
    expect(await h.drain()).toBeGreaterThan(0)
  })

  it('refuses a commit whose base is no longer the head', async () => {
    const h = await harness()
    const c = await h.collection()
    const r1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [type('Author', authorSchema, [up('Author', 'a', { name: 'A' })])],
      metadata: null,
    })
    if (r1.status !== 'committed') throw new Error(r1.status)
    const fromV1 = (name: string) =>
      commitVersion(h.ports, {
        collectionId: c.id,
        base: baseOf(r1.version),
        types: [type('Author', authorSchema, [up('Author', 'a', { name })])],
        metadata: null,
      })
    const [x, y] = [await fromV1('X'), await fromV1('Y')]
    expect(x.status).toBe('committed')
    expect(y.status).toBe('conflict')
    const versions = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    expect(versions.map((v) => v.seq).sort()).toEqual([1, 2])
    // A commit racing from an empty collection also loses cleanly.
    const fromNull = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [type('Author', authorSchema, [up('Author', 'b', { name: 'B' })])],
      metadata: null,
    })
    expect(fromNull.status).toBe('conflict')
  })

  it('moves types between sets and removes types', async () => {
    const h = await harness()
    const c = await h.collection()
    const repo = await h.ports.stores.forCollection(c.id)
    const v1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [
        type('Author', authorSchema, [
          up('Author', 'a', { name: 'A' }),
          up('Author', 'b', { name: 'B' }),
        ]),
        type('Secret', secretSchema, null, [up('Secret', 's', { note: 'shh' })]),
      ],
      metadata: null,
    })
    if (v1.status !== 'committed') throw new Error(v1.status)
    const root1 = await repo.root(v1.version.hash)
    expect(Object.keys(root1.public.types)).toEqual(['Author'])
    expect(Object.keys((await repo.privateSet(root1.private!)).types)).toEqual(['Secret'])

    // Author becomes private: its tree moves to the private set unchanged.
    const privAuthor = { ...authorSchema, private: true }
    const v2 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v1.version),
      types: [type('Author', privAuthor, null), type('Secret', secretSchema, null)],
      metadata: null,
    })
    if (v2.status !== 'committed') throw new Error(v2.status)
    expect(v2.version.semver).toBe('v2.0.0')
    const root2 = await repo.root(v2.version.hash)
    const priv2 = await repo.privateSet(root2.private!)
    expect(root2.public.types).toEqual({})
    expect(priv2.types.Author!.root).toBe(root1.public.types.Author!.root)

    // Secret is removed; Author becomes public again.
    const v3 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v2.version),
      types: [type('Author', authorSchema, null)],
      metadata: null,
    })
    if (v3.status !== 'committed') throw new Error(v3.status)
    const root3 = await repo.root(v3.version.hash)
    expect(root3.private).toBe(null)
    expect(root3.public.types.Author!.root).toBe(root1.public.types.Author!.root)
    expect(v3.version.changes).toMatchObject({ removed: 1 })
  })

  it('refuses a version holding one id in both sets', async () => {
    const h = await harness()
    const c = await h.collection()
    const v1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [type('Author', authorSchema, [up('Author', 'a', { name: 'A' })])],
      metadata: null,
    })
    if (v1.status !== 'committed') throw new Error(v1.status)
    // 'a' added to the private set without leaving the public one.
    const both = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v1.version),
      types: [type('Author', authorSchema, null, [up('Author', 'a', { name: 'secret' })])],
      metadata: null,
    }).catch((e: Error) => e)
    expect(both).toBeInstanceOf(Error)
    expect((both as Error).message).toMatch(/in both the public and private sets/)
    // Moving it (removed from one set, added to the other) is fine.
    const moved = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v1.version),
      types: [type('Author', authorSchema, [del('a')], [up('Author', 'a', { name: 'secret' })])],
      metadata: null,
    })
    expect(moved.status).toBe('committed')
  })

  it('moves file references with a type: public → private → delete', async () => {
    const h = await harness()
    const c = await h.collection()
    const repo = await h.ports.stores.forCollection(c.id)
    await h.ports.db
      .insert(schema.files)
      .values({ hash: FILE, size: 1234, mimeType: 'image/png', storageKey: `files/${FILE}` })
    await h.ports.db.insert(schema.fileUploads).values({
      collectionId: c.id,
      hash: FILE,
      size: 1234,
      mimeType: 'image/png',
      storageKey: `files/${FILE}`,
      status: 'verified',
    })
    const v1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [
        type('Author', authorSchema, [
          up('Author', 'a', { name: 'A', photo: { $file: `sha256:${FILE}` } }),
          up('Author', 'b', { name: 'B' }),
        ]),
      ],
      metadata: null,
    })
    if (v1.status !== 'committed') throw new Error(v1.status)
    expect((await repo.root(v1.version.hash)).public.files.count).toBe(1)

    // The type becomes private: a plain tree move, and its file goes with it.
    const privAuthor = { ...authorSchema, private: true }
    const v2 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v1.version),
      types: [type('Author', privAuthor, null)],
      metadata: null,
    })
    if (v2.status !== 'committed') throw new Error(v2.status)
    const root2 = await repo.root(v2.version.hash)
    const priv2 = await repo.privateSet(root2.private!)
    expect(priv2.types.Author!.schema).toBe(hashSchema(privAuthor))
    expect(root2.public.files).toMatchObject({ root: null, count: 0 })
    expect(priv2.files).toMatchObject({ count: 1, bytes: 1234 })

    // Deleting the record that references it releases the file.
    const v3 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v2.version),
      types: [type('Author', privAuthor, null, [del('a')])],
      metadata: null,
    })
    if (v3.status !== 'committed') throw new Error(v3.status)
    const priv3 = await repo.privateSet((await repo.root(v3.version.hash)).private!)
    expect(priv3.files).toMatchObject({ root: null, count: 0 })
    expect(priv3.types.Author!.count).toBe(1)
  })

  it('moves and removes a type by its per-type file counts, reading no records', async () => {
    const h = await harness()
    const c = await h.collection()
    const repo = await h.ports.stores.forCollection(c.id)
    await h.ports.db
      .insert(schema.files)
      .values({ hash: FILE, size: 1234, mimeType: 'image/png', storageKey: `files/${FILE}` })
    await h.ports.db.insert(schema.fileUploads).values({
      collectionId: c.id,
      hash: FILE,
      size: 1234,
      mimeType: 'image/png',
      storageKey: `files/${FILE}`,
      status: 'verified',
    })
    // Enough records for several leaves; three reference the file.
    const authors = Array.from({ length: 3000 }, (_, i) =>
      up(
        'Author',
        `a${i}`,
        i % 1000 === 0 ? { name: `A${i}`, photo: { $file: `sha256:${FILE}` } } : { name: `A${i}` },
      ),
    )
    const commit = async (base: BaseVersion | null, types: TypeInput[]) => {
      const r = await commitVersion(h.ports, { collectionId: c.id, base, types, metadata: null })
      if (r.status !== 'committed') throw new Error(r.status)
      return r.version
    }
    const v1 = await commit(null, [
      type('Author', authorSchema, authors),
      type('Note', authorSchema, [up('Note', 'n', { name: 'n' })]),
    ])
    const reads = vi.spyOn(Repo.prototype, 'bodyLines')
    reads.mockClear()

    // Public → private, unchanged: the tree and its three references move as they are.
    const privAuthor = { ...authorSchema, private: true }
    const v2 = await commit(baseOf(v1), [
      type('Author', privAuthor, null),
      type('Note', authorSchema, null),
    ])
    expect(reads).not.toHaveBeenCalled()
    const root1 = await repo.root(v1.hash)
    const root2 = await repo.root(v2.hash)
    const priv2 = await repo.privateSet(root2.private!)
    expect(priv2.types.Author!.root).toBe(root1.public.types.Author!.root)
    expect(priv2.files.count).toBe(1)
    expect(root2.public.files.count).toBe(0)

    // Private → public, unchanged: the same tree back, the same as a rebuild makes.
    const v3 = await commit(baseOf(v2), [
      type('Author', authorSchema, null),
      type('Note', authorSchema, null),
    ])
    expect(reads).not.toHaveBeenCalled()
    const root3 = await repo.root(v3.hash)
    expect(root3.public.types.Author!.root).toBe(root1.public.types.Author!.root)
    expect(root3.public.files.count).toBe(1)
    expect(root3.private).toBeNull()
    // Every record counts as added in the public set, as before.
    expect(v3.changes).toMatchObject({ added: 3000 })

    // Removing the type releases its references without reading it.
    const v4 = await commit(baseOf(v3), [type('Note', authorSchema, null)])
    expect(reads).not.toHaveBeenCalled()
    const root4 = await repo.root(v4.hash)
    expect(root4.public.files.count).toBe(0)
    expect(v4.changes).toMatchObject({ removed: 3000 })
    expect(v4.publicRefsRoot).toBeNull()
    reads.mockRestore()
  })

  it('falls back to reading records on a count tree without per-type counts', async () => {
    const h = await harness()
    const c = await h.collection()
    const repo = await h.ports.stores.forCollection(c.id)
    await h.ports.db
      .insert(schema.files)
      .values({ hash: FILE, size: 1234, mimeType: 'image/png', storageKey: `files/${FILE}` })
    await h.ports.db.insert(schema.fileUploads).values({
      collectionId: c.id,
      hash: FILE,
      size: 1234,
      mimeType: 'image/png',
      storageKey: `files/${FILE}`,
      status: 'verified',
    })
    const v1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [
        type('Author', authorSchema, [
          up('Author', 'a', { name: 'A', photo: { $file: `sha256:${FILE}` } }),
        ]),
      ],
      metadata: null,
    })
    if (v1.status !== 'committed') throw new Error(v1.status)
    // The count tree an older writer made: set counts only, no per-type keys or marker.
    const legacy = await applyFileSet(
      repo,
      { refsRoot: null, files: { root: null, count: 0, bytes: 0 } },
      new Map([[FILE, 1]]),
      null,
      async (hs) => new Map(hs.map((x) => [x, 1234])),
    )
    expect(await tracksTypes(repo, legacy.refsRoot)).toBe(false)
    const reads = vi.spyOn(Repo.prototype, 'bodyLines')
    reads.mockClear()
    const v2 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: { ...baseOf(v1.version), publicRefsRoot: legacy.refsRoot },
      types: [type('Author', { ...authorSchema, private: true }, null)],
      metadata: null,
    })
    if (v2.status !== 'committed') throw new Error(v2.status)
    expect(reads).toHaveBeenCalled()
    reads.mockRestore()
    const root2 = await repo.root(v2.version.hash)
    expect((await repo.privateSet(root2.private!)).files.count).toBe(1)
    // The private tree was empty, so it starts with per-type counts; the public one stays legacy.
    expect(await tracksTypes(repo, v2.version.privateRefsRoot)).toBe(true)
  })

  it('keeps file sets by reference', async () => {
    const h = await harness()
    const c = await h.collection()
    const repo = await h.ports.stores.forCollection(c.id)
    const withPhoto = (id: string) =>
      up('Author', id, { name: id, photo: { $file: `sha256:${FILE}` } })
    const attempt = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [type('Author', authorSchema, [withPhoto('a')])],
      metadata: null,
    }).catch((e) => e)
    expect(attempt).toBeInstanceOf(MissingFilesError)

    // A file row alone isn't enough: the bytes must have been uploaded under this collection.
    await h.ports.db
      .insert(schema.files)
      .values({ hash: FILE, size: 1234, mimeType: 'image/png', storageKey: `files/${FILE}` })
    expect(
      await commitVersion(h.ports, {
        collectionId: c.id,
        base: null,
        types: [type('Author', authorSchema, [withPhoto('a')])],
        metadata: null,
      }).catch((e) => e),
    ).toBeInstanceOf(MissingFilesError)
    await h.ports.db.insert(schema.fileUploads).values({
      collectionId: c.id,
      hash: FILE,
      size: 1234,
      mimeType: 'image/png',
      storageKey: `files/${FILE}`,
      status: 'verified',
    })
    const v1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [type('Author', authorSchema, [withPhoto('a'), withPhoto('b')], [withPhoto('p')])],
      metadata: null,
    })
    if (v1.status !== 'committed') throw new Error(v1.status)
    const root1 = await repo.root(v1.version.hash)
    expect(root1.public.files).toMatchObject({ count: 1, bytes: 1234 })
    expect((await repo.privateSet(root1.private!)).files.count).toBe(1)

    // Dropping one public reference keeps the file; dropping both removes it
    // from the public set, but the cumulative public files tree keeps it.
    const v2 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v1.version),
      types: [type('Author', authorSchema, [del('a')], null)],
      metadata: null,
    })
    if (v2.status !== 'committed') throw new Error(v2.status)
    expect((await repo.root(v2.version.hash)).public.files.count).toBe(1)
    const v3 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v2.version),
      types: [type('Author', authorSchema, [del('b')], null)],
      metadata: null,
    })
    if (v3.status !== 'committed') throw new Error(v3.status)
    expect((await repo.root(v3.version.hash)).public.files.count).toBe(0)
    const [col] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    const cumulative = await collect(iterate(new RepoSource(fileTree, repo), col!.publicFilesRoot))
    expect(cumulative.map((f) => f.key)).toEqual([FILE])
  })

  it('revalidates records when a schema changes', async () => {
    const h = await harness()
    const c = await h.collection()
    const v1 = await commitVersion(h.ports, {
      collectionId: c.id,
      base: null,
      types: [
        type('Author', authorSchema, [
          up('Author', 'a', { name: 'A' }),
          up('Author', 'b', { name: 7 }),
        ]),
      ],
      metadata: null,
    })
    if (v1.status !== 'committed') throw new Error(v1.status)
    const strict = { ...authorSchema, required: ['name'], additionalProperties: false }
    const validate = (_s: Record<string, unknown>, data: unknown) =>
      typeof (data as { name?: unknown }).name === 'string' ? null : ['/name must be string']
    const r = await commitVersion(h.ports, {
      collectionId: c.id,
      base: baseOf(v1.version),
      types: [type('Author', strict, null)],
      metadata: null,
      validate,
    })
    expect(r).toMatchObject({
      status: 'invalid',
      total: 1,
      errors: [{ recordId: 'b', type: 'Author' }],
    })
  })
})

describe('publishVersion', () => {
  const row = (collectionId: string, id: string) => ({
    id,
    collectionId,
    seq: 1,
    semver: 'v1.0.0',
    major: 1,
    minor: 0,
    patch: 0,
    hash: `ulv2:${'0'.repeat(64)}`,
    baseSemver: null,
    message: null,
    pushedBy: null,
    appId: null,
    actorId: null,
    recordCount: 0,
    publicRecordCount: 0,
    fileCount: 0,
    totalBytes: 0,
    publicFileCount: 0,
    publicTotalBytes: 0,
    typeCounts: {},
    publicTypeCounts: {},
    hasPrivate: false,
    publicRefsRoot: null,
    privateRefsRoot: null,
    changes: { added: 0, removed: 0, updated: 0 },
  })

  it('records a fork in the publish batch, and not when the publish loses', async () => {
    const h = await harness()
    const parent = await h.collection('parent')
    const child = await h.collection('child')
    const fork = { parentCollectionId: parent.id, parentSeq: 1, sets: 'public' as const }
    const input = (id: string, baseVersionId: string | null) => ({
      fence: 0,
      version: row(child.id, id),
      baseVersionId,
      collectionUpdate: { publicFilesRoot: null, summary: null },
      schemaHashes: [],
      usage: [],
      fork,
    })
    // The head isn't 'nope', so this publish loses: no version, no fork row.
    expect((await publishVersion(h.ports.db, input(crypto.randomUUID(), 'nope'))).ok).toBe(false)
    expect(await h.ports.db.select().from(schema.forks)).toEqual([])
    expect((await publishVersion(h.ports.db, input(crypto.randomUUID(), null))).ok).toBe(true)
    expect(await h.ports.db.select().from(schema.forks)).toMatchObject([
      { childCollectionId: child.id, parentCollectionId: parent.id, parentSeq: 1, sets: 'public' },
    ])
  })
})
