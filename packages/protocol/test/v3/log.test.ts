/** Commits and the log: creating, racing, finding the head, checking the chain. */
import { describe, expect, it } from 'vitest'

import { jcs, memoryStore, type MemoryStore, sha256Hex, type Store, v3 } from '../../src/index.js'
import { putFile, rec } from './helpers.js'

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
      { files: [await fileOf(store, 'a')], bump: 'minor', message: 'first', by: 'travis' },
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
    expect(a.commit.changes[0]).toMatchObject({ message: 'first', by: 'travis' })
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

  it('ignores a failed hint write, and recognises its own commit after an unclear create', async () => {
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
    await rewrite(store, 3, (c) => (c.collection = 'other'))
    await expect(v3.verifyLog(store, 'c')).rejects.toThrow(/carries collection other/)
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
    await v3.createCommit(store, 'c', { files, bump: 'minor' })
    await expect(v3.readCommit(store, 'c', 1)).rejects.toThrow(/overlap/)
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
