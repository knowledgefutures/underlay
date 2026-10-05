import { describe, expect, it } from 'vitest'

import {
  buildTree,
  type Change,
  compareUtf8,
  emptySet,
  type FileEntry,
  fileTree,
  fixedChunking,
  hashRecord,
  hashSchema,
  IntegrityError,
  iterate,
  makeRoot,
  memoryStore,
  mergeTree,
  newNodes,
  newSalt,
  openRepo,
  OUT_OF_LINE_BYTES,
  type PackObject,
  packVersion,
  type PrivateSetObject,
  receiveVersion,
  type RecordEntry,
  recordTree,
  type Repo,
  RepoSink,
  RepoSource,
  type SetObject,
  sha256Hex,
  tarStream,
  untar,
  utf8ByteLength,
  bodyOfRecord,
  checkPrivateSetObject,
  checkSetObject,
  checkVersionRoot,
  jcs,
  privateCommitment,
  versionHash,
  type VersionRoot,
} from '../../src/index.js'

const SCHEMA = { type: 'object', properties: { v: { type: 'integer' } } }
const SCHEMA2 = { type: 'object', properties: { v: { type: 'integer' }, w: {} } }

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

/** A record; every 997th is large enough to be stored out of line. */
async function record(repo: Repo, type: string, id: string, v: number): Promise<RecordEntry> {
  const big = id.endsWith('7') && Number(id.replace(/\D/g, '')) % 997 === 0
  const { hash, canonical } = hashRecord(id, type, {
    v,
    ...(big ? { pad: 'x'.repeat(OUT_OF_LINE_BYTES) } : {}),
  })
  const size = utf8ByteLength(canonical)
  const body = big ? await repo.putOutOfLine(hash, canonical) : canonical
  return { key: id, hash, size, body }
}

/** A version-making helper over a "sender" repository. */
function sender() {
  const repo = openRepo(memoryStore(), { trusted: true })
  const salt = newSalt()
  return {
    repo,
    async tree(entries: RecordEntry[], base: string | null = null) {
      const sink = new RepoSink(repo, { bodyOf: bodyOfRecord })
      const changes: Change<RecordEntry>[] = entries
        .slice()
        .sort((a, b) => compareUtf8(a.key, b.key))
        .map((e) => ({ key: e.key, entry: e }))
      const r = await mergeTree(new RepoSource(recordTree, repo), sink, base, changes)
      await sink.flush()
      return r.root
    },
    async files(hashes: string[]) {
      const sink = new RepoSink<FileEntry>(repo)
      const root = buildTree(
        fileTree,
        sink,
        hashes.sort().map((h) => ({ key: h, size: h.length })),
      )
      await sink.flush()
      return root ? { root: root.hash, count: root.count, bytes: root.bytes } : emptySet().files
    },
    async version(pub: SetObject, priv: SetObject | null) {
      await repo.putSchema(SCHEMA)
      await repo.putSchema(SCHEMA2)
      const privateSet: PrivateSetObject | null = priv ? { ...priv, salt } : null
      if (privateSet) await repo.putPrivateSet(privateSet)
      return repo.putRoot(makeRoot({ title: 't' }, pub, privateSet))
    },
  }
}

const summary = (d: { hash: string; count: number; bytes: number } | null) =>
  d ? { root: d.hash, count: d.count, bytes: d.bytes } : { root: null, count: 0, bytes: 0 }

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(6, '0')}`)

/** Every record (with body) of every tree of a version, by set and type. */
async function contents(repo: Repo, version: string, withPrivate: boolean) {
  const root = await repo.root(version)
  const out: Record<string, string[]> = {}
  const sets: [string, SetObject][] = [['public', root.public]]
  if (withPrivate && root.private) sets.push(['private', await repo.privateSet(root.private)])
  const src = new RepoSource(recordTree, repo)
  for (const [name, set] of sets) {
    for (const [slug, t] of Object.entries(set.types)) {
      const es = await collect(iterate(src, t.root, { payloads: true }))
      out[`${name}/${slug}`] = es.map((e) => `${e.key}:${sha256Hex(e.body!)}`)
    }
  }
  return out
}

async function twoVersions() {
  const s = sender()
  const a = await Promise.all(ids('a', 6000).map((id, i) => record(s.repo, 'A', id, i)))
  const p = await Promise.all(ids('p', 500).map((id, i) => record(s.repo, 'P', id, i)))
  const ta = await s.tree(a)
  const tp = await s.tree(p)
  const f1 = await s.files([sha256Hex('f1'), sha256Hex('f2')])
  const schema = hashSchema(SCHEMA)
  const v1 = await s.version(
    { types: { A: { schema, ...summary(ta) } }, files: f1 },
    { types: { P: { schema, ...summary(tp) } }, files: emptySet().files },
  )
  // v2: updates and inserts in A, a new type B, a file added, P updated.
  const changed = await Promise.all(
    [...ids('a', 6000).filter((_, i) => i % 400 === 0), ...ids('a9', 30)].map((id, i) =>
      record(s.repo, 'A', id, 10_000 + i),
    ),
  )
  const ta2 = await s.tree(changed, ta!.hash)
  const tb = await s.tree(
    await Promise.all(ids('b', 1500).map((id, i) => record(s.repo, 'B', id, i))),
  )
  const tp2 = await s.tree([await record(s.repo, 'P', 'p000003', 99)], tp!.hash)
  const f2 = await s.files([sha256Hex('f1'), sha256Hex('f2'), sha256Hex('f3')])
  const v2 = await s.version(
    {
      types: {
        A: { schema, ...summary(ta2) },
        B: { schema: hashSchema(SCHEMA2), ...summary(tb) },
      },
      files: f2,
    },
    { types: { P: { schema, ...summary(tp2) } }, files: emptySet().files },
  )
  return { s, v1, v2 }
}

describe('tree sync', () => {
  it('moves a whole version, then only what changed', async () => {
    const { s, v1, v2 } = await twoVersions()
    const r = openRepo(memoryStore())
    const full = await collect(packVersion(s.repo, v1))
    await receiveVersion(r, full, { target: v1 })
    expect(await contents(r, v1, false)).toEqual(await contents(s.repo, v1, false))

    const delta = await collect(packVersion(s.repo, v2, { base: v1 }))
    expect(delta.length).toBeLessThan(full.length)
    // Only the new type's leaves come whole; A's changes touch a few leaves.
    const result = await receiveVersion(r, delta, { target: v2, base: v1 })
    expect(result.root).toEqual(await s.repo.root(v2))
    expect(await contents(r, v2, false)).toEqual(await contents(s.repo, v2, false))
    // A second receive of the same pack is a no-op that still verifies.
    await receiveVersion(r, delta, { target: v2, base: v1 })
  })

  it("holds out-of-line records to the receiver's size policy when asked", async () => {
    const { s, v1 } = await twoVersions()
    const full = await collect(packVersion(s.repo, v1))
    // The sender stores only records over OUT_OF_LINE_BYTES out of line: accepted.
    await receiveVersion(openRepo(memoryStore()), full, {
      target: v1,
      inlineUpTo: OUT_OF_LINE_BYTES,
    })
    // A receiver that keeps every record of up to 1 MB inline refuses them.
    await expect(
      receiveVersion(openRepo(memoryStore()), full, { target: v1, inlineUpTo: 1024 * 1024 }),
    ).rejects.toThrow(/out of line; this repository keeps records up to/)
  })

  it('leaves private sets out unless asked, and moves them when asked', async () => {
    const { s, v1, v2 } = await twoVersions()
    const pub = await collect(packVersion(s.repo, v1))
    expect(pub.some((o) => o.key.startsWith('private/'))).toBe(false)
    // No node or body of the private tree travels in a public pack.
    const root = await s.repo.root(v1)
    const priv = await s.repo.privateSet(root.private!)
    const src = new RepoSource(recordTree, s.repo)
    const privKeys = new Set<string>()
    for await (const n of newNodes(src, null, priv.types.P!.root)) {
      privKeys.add(`nodes/${n.hash}`)
      if (n.level === 0) privKeys.add(`bodies/${n.hash}.ndjson.gz`)
    }
    expect(privKeys.size).toBeGreaterThan(1)
    expect(pub.filter((o) => privKeys.has(o.key))).toEqual([])

    const r = openRepo(memoryStore())
    await receiveVersion(r, await collect(packVersion(s.repo, v1, { sets: 'all' })), {
      target: v1,
      sets: 'all',
    })
    const delta = await collect(packVersion(s.repo, v2, { base: v1, sets: 'all' }))
    expect(delta.some((o) => o.key.startsWith('private/'))).toBe(true)
    await receiveVersion(r, delta, { target: v2, base: v1, sets: 'all' })
    expect(await contents(r, v2, true)).toEqual(await contents(s.repo, v2, true))
  })

  it('travels as a tar', async () => {
    const { s, v1 } = await twoVersions()
    const objects = await collect(packVersion(s.repo, v1))
    const tar = tarStream(
      objects.map((o) => ({
        name: o.key,
        size: o.bytes.byteLength,
        body: async function* () {
          yield o.bytes
        },
      })),
    )
    const r = openRepo(memoryStore())
    const back = (async function* (): AsyncGenerator<PackObject> {
      for await (const f of untar(tar)) yield { key: f.name, bytes: f.bytes }
    })()
    await receiveVersion(r, back, { target: v1 })
    expect(await contents(r, v1, false)).toEqual(await contents(s.repo, v1, false))
  })

  describe('refuses a bad pack, and never writes its root', () => {
    const attempt = async (edit: (objects: PackObject[]) => PackObject[], pattern: RegExp) => {
      const { s, v1, v2 } = await twoVersions()
      const r = openRepo(memoryStore())
      await receiveVersion(r, await collect(packVersion(s.repo, v1)), { target: v1 })
      const objects = edit(await collect(packVersion(s.repo, v2, { base: v1 })))
      const err = await receiveVersion(r, objects, { target: v2, base: v1 }).catch((e: Error) => e)
      expect(err).toBeInstanceOf(IntegrityError)
      expect((err as Error).message).toMatch(pattern)
      expect(await r.blobs.head(`roots/${v2.slice(5)}.json`)).toBe(null)
    }
    const flip = (b: Uint8Array) => {
      const c = b.slice()
      c[c.length - 9]! ^= 1
      return c
    }

    it('a node whose bytes are wrong', () =>
      attempt(
        (os) => os.map((o) => (o.key.startsWith('nodes/') ? { ...o, bytes: flip(o.bytes) } : o)),
        /./,
      ))

    it('a leaf without its body', () =>
      attempt((os) => os.filter((o) => !o.key.startsWith('bodies/')), /has no body/))

    it("a body holding another leaf's records", async () => {
      await attempt((os) => {
        const bodies = os.filter((o) => o.key.startsWith('bodies/'))
        const [x, y] = [bodies[0]!, bodies[1]!]
        return os.map((o) => (o === x ? { ...o, bytes: y.bytes } : o))
      }, /line count|fails its hash/)
    })

    it('a node missing from the pack', () =>
      attempt((os) => {
        const i = os.findIndex((o) => o.key.startsWith('nodes/'))
        return os.filter((_, j) => j !== i)
      }, /./))

    it('the root of another version', async () => {
      const { s, v1, v2 } = await twoVersions()
      const r = openRepo(memoryStore())
      const objects = await collect(packVersion(s.repo, v1))
      const err = await receiveVersion(r, objects, { target: v2 }).catch((e: Error) => e)
      expect((err as Error).message).toMatch(/another version's root/)
    })

    it('an object a pack may not carry', () =>
      attempt(
        (os) => [{ key: 'collections/x/head.json', bytes: new Uint8Array([1]) }, ...os],
        /can't hold/,
      ))
  })

  describe("refuses leaf entries that don't match their records", () => {
    // A hostile sender builds a canonical tree from entries that lie about their
    // records: every node and body line still hashes to what points at it.
    // Every object in the sender's store, in pack order, packed by hand: the
    // library itself won't pack a node it can't decode.
    const rawPack = (repo: Repo): PackObject[] => {
      const order = ['schemas/', 'nodes/', 'records/', 'bodies/', 'private/', 'roots/']
      return [...(repo.blobs as ReturnType<typeof memoryStore>).objects.entries()]
        .map(([key, o]) => ({ key, bytes: o.bytes }))
        .sort(
          (a, b) =>
            order.findIndex((p) => a.key.startsWith(p)) -
            order.findIndex((p) => b.key.startsWith(p)),
        )
    }
    const hostile = async (
      lie: (good: RecordEntry) => RecordEntry,
      pattern: RegExp,
      byHand = false,
    ) => {
      const s = sender()
      const entries = await Promise.all(ids('a', 50).map((id, i) => record(s.repo, 'A', id, i)))
      entries[7] = lie(entries[7]!)
      const tree = await s.tree(entries)
      const v = await s.version(
        { types: { A: { schema: hashSchema(SCHEMA), ...summary(tree) } }, files: emptySet().files },
        null,
      )
      const r = openRepo(memoryStore())
      const pack = byHand ? rawPack(s.repo) : await collect(packVersion(s.repo, v))
      const err = await receiveVersion(r, pack, { target: v }).catch((e: Error) => e)
      expect(err).toBeInstanceOf(IntegrityError)
      expect((err as Error).message).toMatch(pattern)
      expect(await r.blobs.head(`roots/${v.slice(5)}.json`)).toBe(null)
    }
    const line = (id: string, type: string, text: string) => {
      const size = utf8ByteLength(text)
      return { key: id, hash: sha256Hex(text), size, body: text }
    }

    it('a size that is not the record’s', () =>
      hostile((e) => ({ ...e, size: e.size + 5 }), /size/))

    it('an id that is not the record’s', () =>
      hostile((e) => {
        const { canonical } = hashRecord('someone-else', 'A', { v: 7 })
        return line(e.key, 'A', canonical)
      }, /id/))

    it('a record of another type', () =>
      hostile((e) => line(e.key, 'B', hashRecord(e.key, 'B', { v: 7 }).canonical), /type/))

    it('a record line that is not canonical', () =>
      hostile(
        (e) => line(e.key, 'A', hashRecord(e.key, 'A', { v: 7 }).canonical.replace(':7', ': 7')),
        /canonical/,
      ))

    it('a key with a lone surrogate', () =>
      hostile(
        (e) => {
          const id = `${e.key}\uD800`
          return line(id, 'A', hashRecord(id, 'A', { v: 7 }).canonical)
        },
        /surrogate/,
        true,
      ))

    it('a key over the id length limit', () =>
      hostile(
        (e) => {
          const id = `${e.key}${'x'.repeat(1100)}`
          return line(id, 'A', hashRecord(id, 'A', { v: 7 }).canonical)
        },
        /id length/,
        true,
      ))
  })

  it('refuses a tree that hashes correctly but is not canonical', async () => {
    // Built under a different chunking: every node is well formed and hashes to
    // its key, but the protocol would never build this tree from these entries.
    const s = sender()
    const entries = await Promise.all(ids('a', 3000).map((id, i) => record(s.repo, 'A', id, i)))
    const sink = new RepoSink(s.repo, { bodyOf: bodyOfRecord })
    const odd = buildTree(recordTree, sink, entries, {
      chunking: fixedChunking({ leafBits: 6, stepBits: 2, leafMax: 512, interiorMax: 64 }),
    })!
    await sink.flush()
    const v = await s.version(
      { types: { A: { schema: hashSchema(SCHEMA), ...summary(odd) } }, files: emptySet().files },
      null,
    )
    const r = openRepo(memoryStore())
    const err = await receiveVersion(r, await collect(packVersion(s.repo, v)), { target: v }).catch(
      (e: Error) => e,
    )
    expect((err as Error).message).toMatch(/not the canonical tree/)
  })

  describe('refuses a root or private set of the wrong shape (section 10)', () => {
    const enc = new TextEncoder()
    const H = (c: string) => c.repeat(64)
    const good = { underlay: 2, metadata: null, public: emptySet(), private: null }
    const entry = { schema: H('a'), root: null, count: 0, bytes: 0 }
    const rootObject = (root: unknown): PackObject => ({
      key: `roots/${versionHash(root as VersionRoot).slice(5)}.json`,
      bytes: enc.encode(jcs(root)),
    })
    const receive = async (
      root: unknown,
      extra: PackObject[] = [],
      r = openRepo(memoryStore()),
    ) => {
      const target = versionHash(root as VersionRoot)
      const sets = extra.length > 0 ? ('all' as const) : ('public' as const)
      const err = await receiveVersion(r, [...extra, rootObject(root)], { target, sets }).then(
        () => null,
        (e: Error) => e,
      )
      if (err) {
        expect(err).toBeInstanceOf(IntegrityError)
        expect(await r.blobs.head(`roots/${target.slice(5)}.json`)).toBe(null)
      }
      return err?.message ?? null
    }

    it('accepts a well-formed root', async () => {
      expect(await receive(good)).toBe(null)
      expect(await receive({ ...good, metadata: { title: 't' } })).toBe(null)
    })

    it('refuses members other than underlay, metadata, public and private', async () => {
      expect(await receive({ ...good, extra: 1 })).toMatch(/root: unexpected fields/)
      const { private: _p, ...noPrivate } = good
      expect(await receive(noPrivate)).toMatch(/root: unexpected fields/)
    })

    it('refuses metadata that is not an object or null', async () => {
      for (const metadata of [[], ['a'], 'text', 1, true])
        expect(await receive({ ...good, metadata })).toMatch(/metadata must be an object or null/)
    })

    it('refuses a public set of the wrong shape', async () => {
      const pub = (p: unknown) => receive({ ...good, public: p })
      expect(await pub({ ...emptySet(), extra: 1 })).toMatch(/public set: unexpected fields/)
      expect(await pub({ types: [], files: emptySet().files })).toMatch(/public set: bad types/)
      expect(await pub({ types: {}, files: { root: null, count: 0, bytes: 5 } })).toMatch(
        /root and bytes disagree/,
      )
      expect(await pub({ types: {}, files: { ...emptySet().files, x: 1 } })).toMatch(
        /files: unexpected fields/,
      )
      expect(
        await pub({ types: { T: { ...entry, schema: 'x' } }, files: emptySet().files }),
      ).toMatch(/bad schema hash/)
      for (const slug of [
        'a/b',
        '.hidden',
        'a\\b',
        'tab\t',
        String.fromCharCode(0x7f),
        'x'.repeat(129),
      ])
        expect(await pub({ types: { [slug]: entry }, files: emptySet().files })).toMatch(
          /Type (must|exceeds)/,
        )
    })

    it('refuses a private member that is not a commitment', async () => {
      for (const priv of ['xyz', H('A'), 1, {}])
        expect(await receive({ ...good, private: priv })).toMatch(/bad private commitment/)
    })

    it('refuses an empty or malformed private set, received or already held', async () => {
      const set = (s: Omit<PrivateSetObject, 'salt'>, salt = newSalt()): PrivateSetObject => ({
        ...s,
        salt,
      })
      const withPrivate = (p: PrivateSetObject) => {
        const commitment = privateCommitment(p)
        const root = { ...good, private: commitment }
        const obj = { key: `private/${commitment}.json`, bytes: enc.encode(jcs(p)) }
        return { root, obj }
      }
      // A root names a private set only when it is non-empty.
      const empty = withPrivate(set(emptySet()))
      expect(await receive(empty.root, [empty.obj])).toMatch(/private\/.*: set: empty/)
      const badSalt = withPrivate(set(emptySet(), 'salt'))
      expect(await receive(badSalt.root, [badSalt.obj])).toMatch(/set: bad salt/)
      // Already held here, so not in the pack: checked all the same.
      const r = openRepo(memoryStore())
      await r.putPrivateSet(set(emptySet(), H('b')))
      const held = withPrivate(set(emptySet(), H('b')))
      const err = await receiveVersion(r, [rootObject(held.root)], {
        target: versionHash(held.root as VersionRoot),
        sets: 'all',
      }).catch((e: Error) => e)
      expect(err).toBeInstanceOf(IntegrityError)
      expect((err as Error).message).toMatch(/^Private set .*: set: empty/)
    })

    it('agrees with the roots and sets the library writes', async () => {
      const { s, v1, v2 } = await twoVersions()
      for (const v of [v1, v2]) {
        const root = await s.repo.root(v)
        expect(checkVersionRoot(root)).toBe(null)
        expect(checkPrivateSetObject(await s.repo.privateSet(root.private!))).toBe(null)
      }
      expect(checkVersionRoot(makeRoot(null, emptySet(), null))).toBe(null)
      expect(checkVersionRoot({ ...good, underlay: 3 })).toMatch(/bad protocol version/)
      expect(checkSetObject(emptySet())).toBe(null)
    })
  })
})
