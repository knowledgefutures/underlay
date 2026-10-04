import { describe, expect, it } from 'vitest'

import {
  appendLog,
  ed25519Signer,
  entryHash,
  generateSigningKey,
  keyIdOf,
  readHead,
  signEntry,
  verifyEntry,
  verifyLog,
} from '../../src/repo/log.js'
import { IntegrityError, keys, Repo } from '../../src/repo/repo.js'
import { memoryStore } from '../../src/stores/memory.js'

const repoOver = (blobs = memoryStore()) => ({
  blobs,
  repo: new Repo(blobs, { scope: 't', trusted: true }),
})

const entry = (seq: number, prev: string | null) => ({
  seq,
  semver: `v1.${seq - 1}.0`,
  versionHash: `ulv2:${String(seq).padStart(64, '0')}`,
  baseSemver: seq === 1 ? null : `v1.${seq - 2}.0`,
  message: `push ${seq}`,
  appId: null,
  actorId: null,
  createdAt: new Date(Date.UTC(2026, 9, 3, 12, seq)).toISOString(),
  prev,
})

describe('version log', () => {
  it('signs and verifies entries with Ed25519', async () => {
    const signer = await ed25519Signer(await generateSigningKey())
    const e = await signEntry(signer, entry(1, null))
    expect(await verifyEntry(e, [signer.publicKey])).toBe(true)
    expect(await verifyEntry({ ...e, message: 'tampered' }, [signer.publicKey])).toBe(false)
    const other = await ed25519Signer(await generateSigningKey())
    expect(await verifyEntry(e, [other.publicKey])).toBe(false)
  })

  it('trusts a key only under its own id', async () => {
    const trusted = await ed25519Signer(await generateSigningKey())
    const forger = await ed25519Signer(await generateSigningKey())
    expect(keyIdOf(trusted.publicKey.publicKey)).toBe(trusted.keyId)
    // The forger signs under the trusted key's id and lists its own key under that id.
    const e = await signEntry({ ...forger, keyId: trusted.keyId }, entry(1, null))
    expect(await verifyEntry(e, [{ ...forger.publicKey, id: trusted.keyId }])).toBe(false)
    expect(await verifyEntry(e, [trusted.publicKey])).toBe(false)
  })

  it('derives the same key from the same seed', async () => {
    const seed = await generateSigningKey()
    expect((await ed25519Signer(seed)).publicKey).toEqual((await ed25519Signer(seed)).publicKey)
  })

  it('appends a hash-chained log and verifies it end to end', async () => {
    const { blobs, repo } = repoOver()
    const signer = await ed25519Signer(await generateSigningKey())
    let prev: string | null = null
    for (let seq = 1; seq <= 3; seq++) {
      const e = await signEntry(signer, entry(seq, prev))
      await appendLog(repo, 'c1', e)
      prev = entryHash(e)
    }
    expect((await readHead(repo, 'c1'))!.seq).toBe(3)
    const { entries } = await verifyLog(repo, 'c1', [signer.publicKey])
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3])

    // A dropped entry breaks the chain.
    const two = blobs.objects.get(keys.logEntry('c1', 2))!
    blobs.objects.delete(keys.logEntry('c1', 2))
    await expect(verifyLog(repo, 'c1', [signer.publicKey])).rejects.toThrow(IntegrityError)
    blobs.objects.set(keys.logEntry('c1', 2), two)
    await expect(verifyLog(repo, 'c1', [signer.publicKey])).resolves.toBeTruthy()
  })
})
