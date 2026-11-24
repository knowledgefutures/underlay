import { describe, expect, it } from 'vitest'

import { Remote, RemoteError, withRetry } from '../src/core/remote.js'

describe('commitUpload', () => {
  /** A server whose upload is in `status`, and which refuses a commit of it with 409. */
  const remote = (status: string) =>
    new Remote('test', 'http://test', 'key', async (url, init) =>
      init?.method === 'POST'
        ? Response.json({ error: `Upload is ${status}`, statusCode: 409 }, { status: 409 })
        : Response.json({ id: 'u', status, result: { hash: 'ulv3:x' } }),
    )

  it('takes the upload’s status as the answer when a commit sent twice is refused', async () => {
    // The first send went through and its answer was lost; the second finds it committed.
    const s = await remote('committed').commitUpload('o', 'c', 'u', {
      record_files: [],
      commit: '{}',
    })
    expect(s).toMatchObject({ status: 'committed', result: { hash: 'ulv3:x' } })
  })

  it('still fails when the upload was never taken', async () => {
    await expect(
      remote('open').commitUpload('o', 'c', 'u', { record_files: [], commit: '{}' }),
    ).rejects.toThrow(RemoteError)
  })
})

describe('withRetry', () => {
  it('sends again after a dropped connection or a 5xx, and gives up on a 4xx', async () => {
    let calls = 0
    const flaky = async () => {
      if (++calls < 3) throw new TypeError('fetch failed')
      return 'sent'
    }
    expect(await withRetry('send', flaky, () => {}, { baseMs: 1 })).toBe('sent')
    expect(calls).toBe(3)
    calls = 0
    const refuse = (message: string, status: number) => async () => {
      calls++
      throw new RemoteError(message, status, null)
    }
    await expect(
      withRetry('send', refuse('PUT x: 403 Forbidden', 403), () => {}, { baseMs: 1 }),
    ).rejects.toThrow('403')
    expect(calls).toBe(1)
    calls = 0
    await expect(
      withRetry('send', refuse('PUT x: 503', 503), () => {}, { baseMs: 1, attempts: 3 }),
    ).rejects.toThrow('503')
    expect(calls).toBe(3)
  })
})
