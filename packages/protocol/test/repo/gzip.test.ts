import { describe, expect, it } from 'vitest'

import { gunzipText, gzip } from '../../src/repo/gzip.js'

describe('gunzip', () => {
  // A large leaf body is several gzip members in one object. workerd's
  // DecompressionStream reads only the first (checked under wrangler dev,
  // 2026-10-04), so gunzip goes through native zlib where the runtime has it.
  it('reads every member of a multi-member body', async () => {
    const parts = await Promise.all(['a\n', 'b\n', 'c\n'].map((s) => gzip(s)))
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    let at = 0
    for (const p of parts) {
      all.set(p, at)
      at += p.byteLength
    }
    expect(await gunzipText(all)).toBe('a\nb\nc\n')
  })
})
