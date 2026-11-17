import { describe, expect, it } from 'vitest'

import { withRetry } from '../src/commands/upload.js'
import { CliError } from '../src/local.js'

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
    const refuse = (message: string) => async () => {
      calls++
      throw new CliError(message)
    }
    await expect(
      withRetry('send', refuse('PUT x: 403 Forbidden'), () => {}, { baseMs: 1 }),
    ).rejects.toThrow('403')
    expect(calls).toBe(1)
    calls = 0
    await expect(
      withRetry('send', refuse('PUT x: 503'), () => {}, { baseMs: 1, attempts: 3 }),
    ).rejects.toThrow('503')
    expect(calls).toBe(3)
  })
})
