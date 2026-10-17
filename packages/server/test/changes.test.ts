import { keys, MemoryStore, memoryStore, outOfLineHash, Repo, sha256Hex } from '@underlay/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { deltaChanges, stageOutOfLine, takeAheadConfig } from '../src/push/changes.js'
import { type RunEntry, writeRun } from '../src/push/runs.js'

/** A store whose staged-record reads take a while, counting how many run at once. */
class SlowStagingStore extends MemoryStore {
  reading = 0
  mostReading = 0
  override async get(key: string, range?: { offset: number; length?: number }) {
    if (!key.includes('/records/')) return super.get(key, range)
    this.reading++
    this.mostReading = Math.max(this.mostReading, this.reading)
    await new Promise((r) => setTimeout(r, 5))
    this.reading--
    return super.get(key, range)
  }
}

const saved = { ...takeAheadConfig }
afterEach(() => Object.assign(takeAheadConfig, saved))

/** 120 records, every third over OUT_OF_LINE_BYTES and staged; `unstaged` is left out. */
async function setup(unstaged?: string) {
  const internal = new SlowStagingStore()
  const repo = new Repo(memoryStore(), { scope: 't', trusted: true })
  const entries: RunEntry[] = []
  for (let i = 0; i < 120; i++) {
    const k = `r${String(i).padStart(3, '0')}`
    const canonical = JSON.stringify({ title: i % 3 ? `T${i}` : `${i}`.padEnd(70_000, 'x') })
    const h = sha256Hex(canonical)
    const b = i % 3 ? canonical : await stageOutOfLine(internal, 's', h, canonical)
    if (k === unstaged) await internal.delete(`sessions/s/records/${h}.json.gz`)
    entries.push({ t: 'Doc', k, h, s: canonical.length, b })
  }
  const ix = await writeRun(internal, 's', 1, entries)
  const changes = () =>
    deltaChanges(internal, repo, 's', [ix], 'Doc', 'public', false, { pub: false, priv: false })
  return { internal, repo, entries, changes }
}

describe('delta changes', () => {
  it('takes large records ahead of the merge, a bounded number at once, in key order', async () => {
    const { internal, repo, entries, changes } = await setup()
    const seen: string[] = []
    for await (const c of changes()) {
      // A large record is in the repository before its change reaches the merge.
      const hash = outOfLineHash(c.entry!.body)
      if (hash) expect(await repo.blobs.head(keys.record(hash))).not.toBeNull()
      seen.push(c.key)
    }
    expect(seen).toEqual(entries.map((e) => e.k))
    expect(internal.mostReading).toBeGreaterThan(1)
    expect(internal.mostReading).toBeLessThanOrEqual(takeAheadConfig.entries)
  })

  it('takes one at a time when nothing may wait, and within the byte bound', async () => {
    takeAheadConfig.entries = 1
    const one = await setup()
    for await (const _ of one.changes());
    expect(one.internal.mostReading).toBe(1)

    Object.assign(takeAheadConfig, saved, { bytes: 100_000 })
    const two = await setup()
    for await (const _ of two.changes());
    expect(two.internal.mostReading).toBe(2)
  })

  it('fails at the record that was never staged, after the changes before it', async () => {
    const { changes } = await setup('r030')
    const seen: string[] = []
    await expect(
      (async () => {
        for await (const c of changes()) seen.push(c.key)
      })(),
    ).rejects.toThrow(/never staged/)
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => `r${String(i).padStart(3, '0')}`))
  })
})
