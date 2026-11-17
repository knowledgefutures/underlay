/** Commits built by their author, replays, and receipts (Sections 4.6 and 4.7). */
import { describe, expect, it } from 'vitest'

import { createObject, ed25519Signer, memoryStore, type MemoryStore, v3 } from '../../src/index.js'
import { putFile, rec } from './helpers.js'

const seed = (n: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(n)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function fileOf(store: MemoryStore, id: string, type = 't'): Promise<v3.FileRef> {
  const f = await putFile(store, [rec(type, `${id}-1`, { id }), rec(type, `${id}-2`, { id })])
  return v3.fileRef(f.id, f.content)
}

const change = async (store: MemoryStore, id: string, base: string | null = null) =>
  v3.makeChange('c1', { files: [await fileOf(store, id)], base, message: id })

describe('author-built commits', () => {
  it('builds the commit a server would, so its id is the same here and there', async () => {
    const store = memoryStore()
    const at = new Date('2026-11-16T12:00:00Z')
    const ch = await change(store, 'a')
    const mine = await v3.buildCommit({
      collection: 'c1',
      previous: null,
      change: ch,
      bump: 'minor',
      createdAt: at,
    })
    const theirs = await v3.createCommit(
      store,
      'c1',
      { change: ch, bump: 'minor' },
      { now: () => at },
    )
    expect(mine.id).toBe(theirs.id)
    expect(mine.commit).toMatchObject({ number: 1, previous: null, semver: 'v1.0.0' })
    const second = await v3.buildCommit({
      collection: 'c1',
      previous: mine,
      change: await change(store, 'b', mine.id),
      bump: 'major',
    })
    expect(second.commit).toMatchObject({ number: 2, previous: mine.id, semver: 'v2.0.0' })
  })

  it('takes the bump a server finds from the files', async () => {
    const store = memoryStore()
    const records = await fileOf(store, 'r')
    const meta = await fileOf(store, 'm', '$meta')
    expect(v3.commitBump([records], false)).toBe('minor')
    expect(v3.commitBump([meta], false)).toBe('patch')
    expect(v3.commitBump([meta], true)).toBe('major')
  })

  it('replays commits on a new previous, keeping changes and mapping bases', async () => {
    const store = memoryStore()
    const at = () => new Date('2026-11-16T12:00:00Z')
    const one = await v3.buildCommit({
      collection: 'c1',
      previous: null,
      change: await change(store, 'a'),
      bump: 'minor',
    })
    // Two local commits on one; meanwhile someone else's commit 2 landed.
    const mine2 = await v3.buildCommit({
      collection: 'c1',
      previous: one,
      change: await change(store, 'b', one.id),
      bump: 'minor',
    })
    const mine3 = await v3.buildCommit({
      collection: 'c1',
      previous: mine2,
      change: await change(store, 'c', mine2.id),
      bump: 'patch',
    })
    const theirs2 = await v3.buildCommit({
      collection: 'c1',
      previous: one,
      change: await change(store, 'x', one.id),
      bump: 'minor',
    })
    const { commits, ids } = await v3.replayCommits(
      [mine2, mine3],
      theirs2,
      (c) => (c.commit.semver.endsWith('.0') ? 'minor' : 'patch'),
      at,
    )
    expect(commits.map((c) => [c.commit.number, c.commit.semver])).toEqual([
      [3, 'v1.2.0'],
      [4, 'v1.2.1'],
    ])
    expect(commits[0]!.commit.previous).toBe(theirs2.id)
    expect(commits[1]!.commit.previous).toBe(commits[0]!.id)
    // The first change's base still names commit 1; the second's names its replayed parent.
    expect(commits[0]!.commit.changes[0]!.base).toBe(one.id)
    expect(commits[1]!.commit.changes[0]!.base).toBe(commits[0]!.id)
    expect(commits[0]!.commit.changes[0]!.files).toEqual(mine2.commit.changes[0]!.files)
    expect(ids.get(mine2.id)).toBe(commits[0]!.id)
  })

  it('checks an author-built commit against the newest, as an authority does', async () => {
    const store = memoryStore()
    const now = new Date('2026-11-16T12:00:00Z')
    const ch = await change(store, 'a')
    const one = await v3.buildCommit({
      collection: 'c1',
      previous: null,
      change: ch,
      bump: 'minor',
      createdAt: now,
    })
    const ok = { head: null, files: ch.files, bump: 'minor' as const, now }
    expect(v3.checkAuthorCommit(one.bytes, 'c1', ok)).toEqual({ commit: one.commit, id: one.id })
    // Someone else's commit 1 is there: stale.
    const other = await v3.buildCommit({
      collection: 'c1',
      previous: null,
      change: await change(store, 'z'),
      bump: 'minor',
    })
    expect(v3.checkAuthorCommit(one.bytes, 'c1', { ...ok, head: other })).toEqual({ stale: true })
    expect(v3.checkAuthorCommit(one.bytes, 'c2', ok)).toHaveProperty('problem')
    expect(
      v3.checkAuthorCommit(one.bytes, 'c1', { ...ok, now: new Date('2026-11-16T13:00:00Z') }),
    ).toHaveProperty('problem')
    expect(v3.checkAuthorCommit(one.bytes, 'c1', { ...ok, files: [] })).toHaveProperty('problem')
    // A number past the newest is never right.
    const two = await v3.buildCommit({
      collection: 'c1',
      previous: one,
      change: await change(store, 'b'),
      bump: 'minor',
      createdAt: now,
    })
    expect(v3.checkAuthorCommit(two.bytes, 'c1', ok)).toEqual({
      problem: 'Commit 2 skips a number',
    })
    const after = { ...ok, head: one, files: two.commit.changes[0]!.files }
    expect(v3.checkAuthorCommit(two.bytes, 'c1', after)).toHaveProperty('id', two.id)
    expect(v3.checkAuthorCommit(two.bytes, 'c1', { ...after, bump: 'major' })).toEqual({
      problem: 'The semver is v2.0.0 for this change, not v1.1.0',
    })
  })
})

describe('receipts', () => {
  it('signs a receipt beside the commit, and a log of author-built commits verifies by it', async () => {
    const store = memoryStore()
    const server = await ed25519Signer(seed(2))
    const stranger = await ed25519Signer(seed(3))
    let prev: v3.StoredCommit | null = null
    for (const id of ['a', 'b']) {
      const c = await v3.buildCommit({
        collection: 'c1',
        previous: prev,
        change: await change(store, id, prev?.id ?? null),
        bump: 'minor',
      })
      expect(await createObject(store, v3.commitKey('c1', c.commit.number), c.bytes)).toBe(true)
      const r = await v3.makeReceipt(c, 'underlay.org', server)
      expect(await v3.writeReceipt(store, r)).toBe(true)
      // Once: a second receipt does not replace the first.
      expect(await v3.writeReceipt(store, { ...r, receivedAt: 'later' })).toBe(false)
      expect(await v3.readReceipt(store, 'c1', c.commit.number)).toEqual(r)
      expect(await v3.verifyReceipt(r, c, [server.publicKey])).toBe(true)
      expect(await v3.verifyReceipt(r, c, [stranger.publicKey])).toBe(false)
      prev = c
    }
    // The receipts do not disturb finding the head.
    expect((await v3.findHead(store, 'c1'))?.id).toBe(prev!.id)
    await expect(v3.verifyLog(store, 'c1', { serverKeys: [server.publicKey] })).rejects.toThrow(
      /nor its receipt/,
    )
    expect(
      (await v3.verifyLog(store, 'c1', { serverKeys: [server.publicKey], receipts: true }))?.id,
    ).toBe(prev!.id)
    await expect(
      v3.verifyLog(store, 'c1', { serverKeys: [stranger.publicKey], receipts: true }),
    ).rejects.toThrow(/nor its receipt/)
  })
})
