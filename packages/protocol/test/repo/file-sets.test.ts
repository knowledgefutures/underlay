import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../../src/hash.js'
import { FileRefDelta } from '../../src/repo/file-sets.js'
import { Repo } from '../../src/repo/repo.js'
import { MemoryStore } from '../../src/stores/memory.js'

/** A store whose record reads take a while, counting how many run at once. */
class SlowRecordStore extends MemoryStore {
  reading = 0
  mostReading = 0
  override async get(key: string, range?: { offset: number; length?: number }) {
    if (!key.includes('records/')) return super.get(key, range)
    this.reading++
    this.mostReading = Math.max(this.mostReading, this.reading)
    await new Promise((r) => setTimeout(r, 5))
    this.reading--
    return super.get(key, range)
  }
}

describe('file reference deltas', () => {
  it('reads out-of-line records several at once and counts each one’s files', async () => {
    const store = new SlowRecordStore()
    const writer = new Repo(store, { scope: 't', trusted: true })
    const refs = new FileRefDelta()
    const files: string[] = []
    for (let i = 0; i < 40; i++) {
      const file = sha256Hex(`file ${i}`)
      files.push(file)
      const canonical = JSON.stringify({
        id: `r${i}`,
        type: 'Doc',
        data: { title: 'x'.repeat(70_000), pdf: { $file: `sha256:${file}` } },
      })
      const hash = sha256Hex(canonical)
      const body = await writer.putOutOfLine(hash, canonical)
      refs.record('public', null, { key: `r${i}`, hash, size: canonical.length, body }, 'Doc')
    }
    // A reader with nothing cached, as a commit unit is.
    await refs.resolve(new Repo(store, { scope: 't', trusted: true }))
    expect([...refs.refs.public.keys()].sort()).toEqual([...files].sort())
    expect([...refs.refs.public.values()].every((n) => n === 1)).toBe(true)
    expect(store.mostReading).toBeGreaterThan(1)
    expect(store.mostReading).toBeLessThanOrEqual(16)
  })
})
