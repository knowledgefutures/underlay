import { describe, expect, it } from 'vitest'

import { pullStream } from '../src/lib/streams.js'

describe('pullStream', () => {
  it('reads its chunks only as the reader takes them, and ends them when the reader cancels', async () => {
    let made = 0
    let closed = false
    const chunks = async function* () {
      try {
        for (;;) {
          made++
          yield new Uint8Array(1 << 20)
        }
      } finally {
        closed = true
      }
    }
    const reader = pullStream(chunks()).getReader()
    // Nothing read yet: at most the one chunk the stream keeps queued.
    await new Promise((r) => setTimeout(r, 20))
    expect(made).toBeLessThanOrEqual(1)
    for (let i = 0; i < 5; i++) expect((await reader.read()).value!.byteLength).toBe(1 << 20)
    await new Promise((r) => setTimeout(r, 20))
    expect(made).toBeLessThanOrEqual(6)
    await reader.cancel()
    expect(closed).toBe(true)
  })

  it('passes on the end and an error', async () => {
    const enc = new TextEncoder()
    const ok = async function* () {
      yield enc.encode('a')
      yield enc.encode('b')
    }
    expect(await new Response(pullStream(ok())).text()).toBe('ab')
    const failing = async function* () {
      yield enc.encode('a')
      throw new Error('read failed')
    }
    await expect(new Response(pullStream(failing())).text()).rejects.toThrow('read failed')
  })
})
