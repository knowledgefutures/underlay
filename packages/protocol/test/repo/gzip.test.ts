import { describe, expect, it } from 'vitest'

import { gunzipMembers, gunzipText, gzip } from '../../src/repo/gzip.js'

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

describe('gunzip where the decoder reads one member (browsers)', () => {
  // Stands in for a DecompressionStream that reads exactly one member and fails
  // on anything else: inflate the deflate data, then check the trailer's CRC and
  // size, so a slice cut anywhere but a member's end throws.
  const zlib = process.getBuiltinModule('node:zlib')
  const oneMember = async (b: Uint8Array) => {
    if (b.length < 18 || b[0] !== 0x1f || b[1] !== 0x8b) throw new Error('not gzip')
    const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
    const out = zlib.inflateRawSync(view.subarray(10, view.length - 8))
    if (view.readUInt32LE(view.length - 4) !== out.length >>> 0) throw new Error('trailing bytes')
    if (view.readUInt32LE(view.length - 8) !== zlib.crc32(out)) throw new Error('bad crc')
    return new Uint8Array(out)
  }

  it('splits the members and reads them all', async () => {
    const texts = ['first line\n', 'x'.repeat(5000) + '\n', '{"id":"\u001f\u008b"}\n', 'last\n']
    const parts = await Promise.all(texts.map((s) => gzip(s)))
    const all = Buffer.concat(parts)
    await expect(oneMember(all)).rejects.toThrow()
    const out = await gunzipMembers(all, oneMember)
    expect(new TextDecoder().decode(out)).toBe(texts.join(''))
    // One member decodes in one go.
    expect(new TextDecoder().decode(await gunzipMembers(parts[0]!, oneMember))).toBe(texts[0])
    // Garbage still fails.
    await expect(gunzipMembers(new Uint8Array([1, 2, 3]), oneMember)).rejects.toThrow()
  })
})
