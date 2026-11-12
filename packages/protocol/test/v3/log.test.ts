/** Commits and the log: creating, racing, finding the head, checking the chain. */
import { describe, expect, it } from 'vitest'

import {
  ed25519Signer,
  hashRecord,
  jcs,
  memoryStore,
  type MemoryStore,
  sha256Hex,
  type Store,
  v3,
} from '../../src/index.js'
import commitVectors from '../vectors/v3-commits.json' with { type: 'json' }
import { putFile, rec, rem } from './helpers.js'

async function fileOf(store: MemoryStore, id: string, n = 3): Promise<v3.FileRef> {
  const f = await putFile(
    store,
    Array.from({ length: n }, (_, i) => rec('t', `${id}-${i}`, { id, i })),
  )
  return v3.fileRef(f.id, f.content)
}

const at = (iso: string) => ({ now: () => new Date(iso) })

describe('commits', () => {
  it('chains commits by version id and numbers them from 1', async () => {
    const store = memoryStore()
    const a = await v3.createCommit(
      store,
      'c1',
      { files: [await fileOf(store, 'a')], bump: 'minor', message: 'first' },
      at('2026-11-10T00:00:00Z'),
    )
    expect(a.commit).toMatchObject({
      underlay: 3,
      collection: 'c1',
      number: 1,
      previous: null,
      semver: 'v1.0.0',
      createdAt: '2026-11-10T00:00:00.000Z',
      keyId: null,
      sig: null,
    })
    expect(a.commit.changes[0]).toMatchObject({
      collection: 'c1',
      base: null,
      message: 'first',
      keyId: null,
      sig: null,
    })
    expect(a.id).toBe('ulv3:' + sha256Hex(jcs(a.commit)))
    const b = await v3.createCommit(store, 'c1', {
      files: [await fileOf(store, 'b')],
      bump: 'minor',
    })
    const c = await v3.createCommit(store, 'c1', {
      files: [await fileOf(store, 'c')],
      bump: 'patch',
    })
    const d = await v3.createCommit(store, 'c1', {
      files: [await fileOf(store, 'd')],
      bump: 'major',
    })
    expect([b, c, d].map((x) => [x.commit.number, x.commit.semver])).toEqual([
      [2, 'v1.1.0'],
      [3, 'v1.1.1'],
      [4, 'v2.0.0'],
    ])
    expect(b.commit.previous).toBe(a.id)
    expect(d.commit.previous).toBe(c.id)
    expect((await v3.findHead(store, 'c1'))!.id).toBe(d.id)
    expect(await v3.readLatest(store, 'c1')).toEqual({ commit: 4, layout: 0 })
    expect(await v3.readCommitHint(store, 'c1')).toBe(4)
    const log: number[] = []
    for await (const x of v3.readLog(store, 'c1', 1, 4, 3)) log.push(x.commit.number)
    expect(log).toEqual([1, 2, 3, 4])
    expect((await v3.verifyLog(store, 'c1', { files: true }))!.id).toBe(d.id)
    expect(await v3.findHead(store, 'none')).toBe(null)
  })

  it('costs the same requests whatever the log holds', async () => {
    const store = memoryStore()
    const files = [await fileOf(store, 'x')]
    const cost = async () => {
      const [gets, puts] = [store.gets, store.puts]
      await v3.createCommit(store, 'c', { files, bump: 'minor' })
      return [store.gets - gets, store.puts - puts]
    }
    expect(await cost()).toEqual([1, 2])
    const second = await cost()
    for (let i = 0; i < 40; i++) await v3.createCommit(store, 'c', { files, bump: 'minor' })
    // The hint, the head commit; the commit, the hint.
    expect(await cost()).toEqual(second)
    expect(second).toEqual([2, 2])
  })

  it('gives racing committers one number each and loses no upload', async () => {
    const store = memoryStore()
    await v3.createCommit(store, 'race', { files: [await fileOf(store, 'seed')], bump: 'minor' })
    const files = await Promise.all(Array.from({ length: 20 }, (_, i) => fileOf(store, `w${i}`)))
    const made = await Promise.all(
      files.map((f) => v3.createCommit(store, 'race', { files: [f], bump: 'minor' })),
    )
    const numbers = made.map((m) => m.commit.number).sort((a, b) => a - b)
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 2))
    const head = await v3.verifyLog(store, 'race', { files: true })
    expect(head!.commit.number).toBe(21)
    expect(head!.commit.semver).toBe('v1.20.0')
    // Every upload is in the log exactly once.
    const named: string[] = []
    for await (const c of v3.readLog(store, 'race', 2, 21))
      named.push(v3.commitFiles(c.commit)[0]!.id)
    expect(named.sort()).toEqual(files.map((f) => f.id).sort())
  })

  it('asks for the kind of change again when another commit lands first', async () => {
    const store = memoryStore()
    await v3.createCommit(store, 'c', { files: [], bump: 'minor' })
    const seen: number[] = []
    const slow = v3.createCommit(store, 'c', {
      files: [],
      bump: async (head) => {
        seen.push(head!.commit.number)
        if (seen.length === 1) await v3.createCommit(store, 'c', { files: [], bump: 'major' })
        return 'patch' as const
      },
    })
    const made = await slow
    expect(seen).toEqual([1, 2])
    expect(made.commit.number).toBe(3)
    expect(made.commit.semver).toBe('v2.0.1')
  })

  it('finds the head with a stale hint, a missing hint, and a hint from a deleted collection', async () => {
    const store = memoryStore()
    const files = [await fileOf(store, 'x')]
    // A clock that moves: these commits are otherwise identical, and made within a millisecond.
    let t = Date.parse('2026-11-10T00:00:00Z')
    const commit = () =>
      v3.createCommit(store, 'c', { files, bump: 'minor' }, { now: () => new Date((t += 1000)) })
    for (let i = 0; i < 37; i++) await commit()
    await store.put(v3.latestKey('c'), jcs({ commit: 3 }))
    expect((await v3.findHead(store, 'c'))!.commit.number).toBe(37)
    expect((await commit()).commit.number).toBe(38)
    await store.delete(v3.latestKey('c'))
    expect(await v3.headNumber(store, 'c')).toBe(38)
    expect((await commit()).commit.number).toBe(39)
    await store.put(v3.latestKey('c'), 'not json')
    expect(await v3.headNumber(store, 'c')).toBe(39)
    await store.put(v3.latestKey('c'), jcs({ commit: 500 }))
    expect(await v3.headNumber(store, 'c')).toBe(39)
    expect((await commit()).commit.number).toBe(40)
    await v3.verifyLog(store, 'c')
  })

  it('ignores a failed hint write, and recognizes its own commit after an unclear create', async () => {
    const inner = memoryStore()
    let failHint = true
    let lie = false
    const store: Store = {
      get: (k, r) => inner.get(k, r),
      head: (k) => inner.head(k),
      list: (p, c) => inner.list(p, c),
      delete: (k) => inner.delete(k),
      put: async (k, b, o) => {
        if (failHint && k.endsWith('latest.json')) throw new Error('429 Too Many Requests')
        return inner.put(k, b, o)
      },
      // A create that lands but reports a loss: a request retried after a lost reply.
      create: async (k, b, o) => {
        const won = await inner.create(k, b, o)
        return lie ? false : won
      },
    }
    for (let i = 0; i < 5; i++) await v3.createCommit(store, 'c', { files: [], bump: 'minor' })
    expect(await v3.readLatest(store, 'c')).toBe(null)
    expect(await v3.headNumber(store, 'c')).toBe(5)
    failHint = false
    lie = true
    const made = await v3.createCommit(store, 'c', { files: [], bump: 'minor' })
    expect(made.commit.number).toBe(6)
    expect(await v3.headNumber(store, 'c')).toBe(6)
  })

  it('refuses a store that cannot create-if-absent', async () => {
    const inner = memoryStore()
    const store: Store = {
      get: (k, r) => inner.get(k, r),
      head: (k) => inner.head(k),
      list: (p, c) => inner.list(p, c),
      delete: (k) => inner.delete(k),
      put: (k, b, o) => inner.put(k, b, o),
    }
    await expect(v3.createCommit(store, 'c', { files: [], bump: 'minor' })).rejects.toThrow(
      /create-if-absent/,
    )
  })
})

describe('checking the log', () => {
  async function three() {
    const store = memoryStore()
    for (const id of ['a', 'b', 'c']) {
      await v3.createCommit(store, 'c', { files: [await fileOf(store, id)], bump: 'minor' })
    }
    return store
  }
  const rewrite = async (store: MemoryStore, n: number, change: (c: v3.Commit) => void) => {
    const c = (await v3.readCommit(store, 'c', n))!.commit
    change(c)
    await store.put(v3.commitKey('c', n), jcs(c))
  }

  it('rejects a commit changed after the fact', async () => {
    const store = await three()
    await rewrite(store, 2, (c) => (c.changes[0]!.message = 'edited'))
    await expect(v3.verifyLog(store, 'c')).rejects.toThrow(/Commit 3.*previous/)
  })

  it('rejects a wrong number, collection, semver, and a commit that is not canonical', async () => {
    let store = await three()
    await rewrite(store, 3, (c) => (c.number = 4))
    await expect(v3.verifyLog(store, 'c')).rejects.toThrow(/another number/)
    store = await three()
    await rewrite(store, 3, (c) => {
      c.collection = 'other'
      c.changes[0]!.collection = 'other'
    })
    await expect(v3.verifyLog(store, 'c')).rejects.toThrow(/carries collection other/)
    // A change is for the collection its commit is in.
    store = await three()
    await rewrite(store, 3, (c) => (c.changes[0]!.collection = 'other'))
    await expect(v3.verifyLog(store, 'c')).rejects.toThrow(/Bad commit change/)
    store = await three()
    await rewrite(store, 3, (c) => (c.semver = 'v1.5.0'))
    await expect(v3.verifyLog(store, 'c')).rejects.toThrow(/semver/)
    store = await three()
    const bytes = (await v3.readCommit(store, 'c', 2))!.bytes
    await store.put(v3.commitKey('c', 2), new TextDecoder().decode(bytes) + ' ')
    await expect(v3.verifyLog(store, 'c')).rejects.toThrow(/canonical/)
  })

  it('rejects a commit whose file is missing or is not what it says', async () => {
    const store = await three()
    const c = (await v3.readCommit(store, 'c', 2))!.commit
    const id = v3.commitFiles(c)[0]!.id
    const kept = await (await store.get(v3.recordKey(id)))!.bytes()
    await store.delete(v3.recordKey(id))
    await v3.verifyLog(store, 'c')
    await expect(v3.verifyLog(store, 'c', { files: true })).rejects.toThrow(v3.MissingFileError)
    const other = v3.commitFiles((await v3.readCommit(store, 'c', 1))!.commit)[0]!.id
    await store.put(v3.recordKey(id), await (await store.get(v3.recordKey(other)))!.bytes())
    await expect(v3.verifyLog(store, 'c', { files: true })).rejects.toThrow(/file id/)
    await store.put(v3.recordKey(id), kept)
    await v3.verifyLog(store, 'c', { files: true })
  })

  it('rejects a commit naming files whose key ranges overlap', async () => {
    const store = memoryStore()
    const a = await putFile(store, [rec('t', 'a', 1), rec('t', 'm', 1)])
    const b = await putFile(store, [rec('t', 'k', 1), rec('t', 'z', 1)])
    const files = [v3.fileRef(a.id, a.content), v3.fileRef(b.id, b.content)]
    // Refused before it is written: a commit no reader takes would end the log.
    await expect(v3.createCommit(store, 'c', { files, bump: 'minor' })).rejects.toThrow(/overlap/)
    expect(await v3.headNumber(store, 'c')).toBe(0)
    // And one written anyway is refused by every read.
    const good = await v3.createCommit(store, 'd', { files: [files[0]!], bump: 'minor' })
    const bad = { ...good.commit, changes: [{ ...good.commit.changes[0]!, files }] }
    await store.put(v3.commitKey('d', 1), v3.commitBytes(bad))
    await expect(v3.readCommit(store, 'd', 1)).rejects.toThrow(/overlap/)
  })

  it('writes no commit a reader would refuse: a bad change, or a file entry with more members', async () => {
    const store = memoryStore()
    const a = await putFile(store, [rec('t', 'a', 1)])
    const ref = v3.fileRef(a.id, a.content)
    const change = await v3.makeChange('c', { files: [ref] })
    for (const bad of [
      { ...change, message: 5 },
      { ...change, extra: true },
      { ...change, keyId: 'k' },
      { ...change, files: [{ ...ref, size: 1 }] },
    ]) {
      await expect(
        v3.createCommit(store, 'c', { change: bad as unknown as v3.Change, bump: 'minor' }),
      ).rejects.toThrow(v3.BaseError)
    }
    expect(await v3.headNumber(store, 'c')).toBe(0)
    expect((await v3.createCommit(store, 'c', { change, bump: 'minor' })).commit.number).toBe(1)
  })

  it("accepts a fork's earlier commits under its lineage", async () => {
    const store = await three()
    for (let n = 1; n <= 2; n++) {
      await store.put(v3.commitKey('fork', n), (await v3.readCommit(store, 'c', n))!.bytes)
    }
    const forked = await v3.createCommit(store, 'fork', { files: [], bump: 'patch' })
    expect(forked.commit.number).toBe(3)
    expect(forked.commit.previous).toBe((await v3.readCommit(store, 'c', 2))!.id)
    await expect(v3.verifyLog(store, 'fork')).rejects.toThrow(/carries collection c/)
    await v3.verifyLog(store, 'fork', { lineage: [['c', 2]] })
  })
})

describe('layouts', () => {
  it('creates numbered layouts once, and finds the newest', async () => {
    const store = memoryStore()
    expect(await v3.findLayout(store, 'c')).toBe(null)
    const layout = (n: number, through: number): v3.Layout => ({
      underlay: 3,
      collection: 'c',
      number: n,
      through,
      createdAt: '2026-11-10T00:00:00.000Z',
      files: [],
    })
    expect(await v3.createLayout(store, layout(1, 4))).toBe(true)
    expect(await v3.createLayout(store, layout(1, 9))).toBe(false)
    expect((await v3.findLayout(store, 'c'))!.through).toBe(4)
    expect(await v3.createLayout(store, layout(2, 9))).toBe(true)
    // A layout writes its own hint and leaves the commit hint alone.
    expect(await v3.readLatest(store, 'c')).toEqual({ commit: 0, layout: 2 })
    expect(await store.head(v3.latestKey('c'))).toBe(null)
    await store.put(v3.layoutHintKey('c'), jcs({ layout: 1 }))
    expect((await v3.findLayout(store, 'c'))!.number).toBe(2)
    await store.delete(v3.layoutHintKey('c'))
    expect((await v3.findLayout(store, 'c'))!.number).toBe(2)
  })
})

describe('base and the two signatures', () => {
  // Fixed keys, so the signatures (Ed25519 is deterministic) are the same every time.
  const seed = (n: number) =>
    btoa(String.fromCharCode(...new Uint8Array(32).fill(n)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  const keys = async () => ({
    author: await ed25519Signer(seed(1)),
    server: await ed25519Signer(seed(2)),
    stranger: await ed25519Signer(seed(3)),
  })

  it('has the author sign the change and the server sign where it landed', async () => {
    const store = memoryStore()
    const k = await keys()
    const first = await v3.createCommit(
      store,
      'c',
      { files: [], bump: 'minor' },
      { signer: k.server },
    )
    const change = await v3.makeChange(
      'c',
      { files: [await fileOf(store, 'a')], base: first.id, message: 'mine' },
      k.author,
    )
    expect(change.keyId).toBe(k.author.keyId)
    const made = await v3.createCommit(store, 'c', { change, bump: 'minor' }, { signer: k.server })
    expect(made.commit.changes[0]).toEqual(change)
    expect(made.commit).toMatchObject({ number: 2, previous: first.id, keyId: k.server.keyId })
    expect(made.id).toBe('ulv3:' + sha256Hex(jcs(made.commit)))
    // Each signature verifies under its own key, and not under the other's.
    expect(await v3.verifyChange(made.commit.changes[0]!, [k.author.publicKey])).toBe(true)
    expect(await v3.verifyChange(made.commit.changes[0]!, [k.server.publicKey])).toBe(false)
    expect(await v3.verifyCommit(made.commit, [k.server.publicKey])).toBe(true)
    expect(await v3.verifyCommit(made.commit, [k.author.publicKey])).toBe(false)
    // The author's signature does not cover the number or the commit before; the server's does.
    const moved = { ...made.commit, number: 9 }
    expect(await v3.verifyChange(moved.changes[0]!, [k.author.publicKey])).toBe(true)
    expect(await v3.verifyCommit(moved, [k.server.publicKey])).toBe(false)
    // A change with anything altered no longer verifies.
    expect(await v3.verifyChange({ ...change, message: 'theirs' }, [k.author.publicKey])).toBe(
      false,
    )
    expect(await v3.verifyChange({ ...change, base: null }, [k.author.publicKey])).toBe(false)
    await v3.verifyLog(store, 'c', { serverKeys: [k.server.publicKey] })
    await expect(v3.verifyLog(store, 'c', { serverKeys: [k.stranger.publicKey] })).rejects.toThrow(
      /server key/,
    )
    // The first commit's change was unsigned, so author keys are not met there.
    await expect(v3.verifyLog(store, 'c', { authorKeys: [k.author.publicKey] })).rejects.toThrow(
      /Commit 1.*author key/,
    )
  })

  it('commits a change that loses the race at the next number, its signature unchanged', async () => {
    const store = memoryStore()
    const k = await keys()
    const first = await v3.createCommit(
      store,
      'c',
      { files: [], bump: 'minor' },
      { signer: k.server },
    )
    // Twelve authors prepare changes from the same base and commit at once.
    const changes = await Promise.all(
      Array.from({ length: 12 }, async (_, i) =>
        v3.makeChange(
          'c',
          { files: [await fileOf(store, `w${i}`)], base: first.id, message: `w${i}` },
          k.author,
        ),
      ),
    )
    const made = await Promise.all(
      changes.map((change) =>
        v3.createCommit(
          store,
          'c',
          { change, bump: 'minor' },
          { signer: k.server, authorKeys: [k.author.publicKey] },
        ),
      ),
    )
    expect(made.map((m) => m.commit.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 2),
    )
    for (let i = 0; i < made.length; i++) {
      const landed = (await v3.readCommit(store, 'c', made[i]!.commit.number))!.commit
      // Byte for byte what the author signed, wherever it landed.
      expect(jcs(landed.changes[0])).toBe(jcs(changes[i]))
      expect(await v3.verifyChange(landed.changes[0]!, [k.author.publicKey])).toBe(true)
      expect(await v3.verifyCommit(landed, [k.server.publicKey])).toBe(true)
      // Only one of them followed its base directly.
      expect(landed.changes[0]!.base).toBe(first.id)
    }
    expect(made.filter((m) => m.commit.previous === first.id).length).toBe(1)
    await v3.verifyLog(store, 'c', {
      from: 2,
      previous: first.id,
      serverKeys: [k.server.publicKey],
      authorKeys: [k.author.publicKey],
    })
  })

  it('records a base as given, and refuses one that is not a version of the collection', async () => {
    const store = memoryStore()
    const made: v3.StoredCommit[] = []
    for (let i = 0; i < 6; i++) {
      made.push(
        await v3.createCommit(
          store,
          'c',
          { files: [], bump: 'minor' },
          at(`2026-11-10T00:00:0${i}Z`),
        ),
      )
    }
    // An old base is fine: nothing refuses a commit because of its base.
    const old = await v3.createCommit(store, 'c', { files: [], base: made[1]!.id, bump: 'minor' })
    expect(old.commit.number).toBe(7)
    expect(old.commit.changes[0]!.base).toBe(made[1]!.id)
    expect(old.commit.previous).toBe(made[5]!.id)
    expect(await v3.findVersion(store, 'c', made[1]!.id, 7)).toBe(2)
    expect(await v3.findVersion(store, 'c', made[1]!.id, 7, { hint: 2 })).toBe(2)
    expect(await v3.findVersion(store, 'c', made[1]!.id, 7, { search: 2 })).toBe(null)
    // A base newer than a stale hint's commit is still found.
    await store.put(v3.latestKey('c'), jcs({ commit: 3 }))
    const fresh = await v3.createCommit(store, 'c', { files: [], base: old.id, bump: 'minor' })
    expect(fresh.commit).toMatchObject({ number: 8, previous: old.id })
    await store.delete(v3.latestKey('c'))
    const noHint = await v3.createCommit(store, 'c', { files: [], base: fresh.id, bump: 'minor' })
    expect(noHint.commit.number).toBe(9)
    // A version of another collection is not.
    const other = await v3.createCommit(store, 'other', { files: [], bump: 'minor' })
    await expect(
      v3.createCommit(store, 'c', { files: [], base: other.id, bump: 'minor' }),
    ).rejects.toThrow(v3.BaseError)
    await expect(
      v3.createCommit(store, 'c', { files: [], base: 'ulv3:' + '0'.repeat(64), bump: 'minor' }),
    ).rejects.toThrow(/not a version/)
    // Nor is a change made for another collection, or one no accepted key signed.
    const k = await keys()
    const foreign = await v3.makeChange('other', { files: [] }, k.author)
    await expect(v3.createCommit(store, 'c', { change: foreign, bump: 'minor' })).rejects.toThrow(
      /for collection other/,
    )
    const unsigned = await v3.makeChange('c', { files: [] })
    await expect(
      v3.createCommit(
        store,
        'c',
        { change: unsigned, bump: 'minor' },
        { authorKeys: [k.author.publicKey] },
      ),
    ).rejects.toThrow(/not signed/)
    const strange = await v3.makeChange('c', { files: [] }, k.stranger)
    await expect(
      v3.createCommit(
        store,
        'c',
        { change: strange, bump: 'minor' },
        { authorKeys: [k.author.publicKey] },
      ),
    ).rejects.toThrow(/not signed/)
    expect(await v3.headNumber(store, 'c')).toBe(9)
    await v3.verifyLog(store, 'c')
  })

  it('accepts a base from the collections a fork came from', async () => {
    const store = memoryStore()
    const parent: v3.StoredCommit[] = []
    for (let i = 0; i < 3; i++)
      parent.push(await v3.createCommit(store, 'p', { files: [], bump: 'minor' }))
    const fork = await v3.forkCollection(store, 'p', 'f', { at: 2 })
    // The fork's log holds the parent's first two commits, so either is a base; the third is not.
    const ok = await v3.createCommit(store, 'f', { files: [], base: parent[0]!.id, bump: 'minor' })
    expect(ok.commit).toMatchObject({ number: 3, previous: parent[1]!.id })
    await expect(
      v3.createCommit(store, 'f', { files: [], base: parent[2]!.id, bump: 'minor' }),
    ).rejects.toThrow(/not a version of f/)
    await v3.verifyLog(store, 'f', { lineage: fork.description.lineage! })
  })

  it('reports the keys a commit wrote that others changed since its base', async () => {
    const store = memoryStore()
    const put = async (rows: v3.WriteRow[], base?: string) => {
      const sorted = rows.sort(v3.compareKey)
      const files = await v3.buildFiles(sorted, v3.storeTarget(store))
      return v3.createCommit(store, 'c', {
        files: files.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ref),
        ...(base === undefined ? {} : { base }),
        bump: 'minor',
      })
    }
    const crossed = async (n: number) => {
      const out: [string, string | null, string | null, number][] = []
      for await (const c of v3.changedSinceBase(store, 'c', n)) {
        out.push([c.id, c.mine?.hash ?? null, c.theirs?.hash ?? null, c.theirCommit])
      }
      return out
    }
    const h = (id: string, data: unknown) => hashRecord(id, 't', data).hash
    const c1 = await put([rec('t', 'a', 1), rec('t', 'b', 1), rec('t', 'c', 1), rec('t', 'd', 1)])
    const c2 = await put([rec('t', 'a', 2), rem('t', 'c')], c1.id)
    await put([rec('t', 'b', 3), rec('t', 'e', 3)], c2.id)
    // An author who last saw commit 1 writes a, c, d, and f.
    await put([rec('t', 'a', 4), rec('t', 'c', 4), rec('t', 'd', 4), rec('t', 'f', 4)], c1.id)
    // a was changed and c removed by commit 2 since that base; d and f were not touched.
    expect(await crossed(4)).toEqual([
      ['a', h('a', 4), h('a', 2), 2],
      ['c', h('c', 4), null, 2],
    ])
    // Commits whose base is the commit before them crossed nothing.
    expect(await crossed(2)).toEqual([])
    expect(await crossed(3)).toEqual([])
    // With no base, everything before counts.
    await put([rec('t', 'e', 5), rec('t', 'zz', 5)])
    expect(await crossed(5)).toEqual([['e', h('e', 5), h('e', 3), 3]])
    // The newest still wins: nothing was refused, and the last writes are what reads see.
    const view = await v3.openView(store, 'c')
    expect((await v3.getRecord(store, view, 't', 'a'))!.hash).toBe(h('a', 4))
    // The report still works once the commits are rebuilt into one file.
    await v3.rebuild(store, 'c', { plan: v3.planAll })
    expect(await crossed(4)).toEqual([
      ['a', h('a', 4), h('a', 2), 2],
      ['c', h('c', 4), null, 2],
    ])
  })
})

describe('commit test vectors', () => {
  it('gives every vector its recorded version id and verifies its signatures', async () => {
    for (const { commit, id } of commitVectors.commits as { commit: v3.Commit; id: string }[]) {
      const bytes = v3.commitBytes(commit)
      expect(v3.versionId(bytes)).toBe(id)
      expect(v3.parseCommit(bytes)).toEqual(commit)
    }
    const signed = commitVectors.commits[1]!.commit as v3.Commit
    const keys = commitVectors.keys as { author: v3.PublicKeyInfo; server: v3.PublicKeyInfo }
    expect(await v3.verifyChange(signed.changes[0]!, [keys.author])).toBe(true)
    expect(await v3.verifyCommit(signed, [keys.server])).toBe(true)
    // Ed25519 is deterministic: signing again with the stated keys gives the recorded signatures.
    const seed = (n: number) =>
      btoa(String.fromCharCode(...new Uint8Array(32).fill(n)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    const again = await v3.signObject(
      { ...signed.changes[0]!, keyId: null, sig: null },
      await ed25519Signer(seed(1)),
    )
    expect(again.sig).toBe(signed.changes[0]!.sig)
    const whole = await v3.signObject(
      { ...signed, keyId: null, sig: null },
      await ed25519Signer(seed(2)),
    )
    expect(whole.sig).toBe(signed.sig)
  })
})
