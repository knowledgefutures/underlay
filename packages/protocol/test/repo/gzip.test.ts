import { describe, expect, it } from 'vitest'

import {
  chunkLines,
  gunzipChunks,
  gunzipMembers,
  gunzipStream,
  gunzipText,
  gzip,
} from '../../src/repo/gzip.js'

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

describe('streaming gunzip', () => {
  it('reads every member, and splits lines across chunk and character boundaries', async () => {
    const lines = Array.from(
      { length: 5000 },
      (_, i) => `{"n":${i},"t":"é😀${'x'.repeat(i % 97)}"}`,
    )
    const text = lines.join('\n') + '\n'
    const half = text.length >> 1
    const body = new Uint8Array([
      ...(await gzip(text.slice(0, half))),
      ...(await gzip(text.slice(half))),
    ])
    const got: string[] = []
    for await (const l of chunkLines(gunzipChunks(body))) got.push(l)
    expect(got).toEqual(lines)
    // Chunks that cut a multi-byte character in two.
    const bytes = new TextEncoder().encode('ab😀c\nd')
    async function* oneByte() {
      for (const b of bytes) yield new Uint8Array([b])
    }
    const split: string[] = []
    for await (const l of chunkLines(oneByte())) split.push(l)
    expect(split).toEqual(['ab😀c', 'd'])
  })

  it('reads compressed input that arrives in chunks, and stops when the reader does', async () => {
    const lines = Array.from(
      { length: 20_000 },
      (_, i) => `{"n":${i},"t":"é${'y'.repeat(i % 89)}"}`,
    )
    const text = lines.join('\n') + '\n'
    const third = Math.floor(text.length / 3)
    const body = new Uint8Array([
      ...(await gzip(text.slice(0, third))),
      ...(await gzip(text.slice(third, 2 * third))),
      ...(await gzip(text.slice(2 * third))),
    ])
    let sent = 0
    async function* pieces(size: number) {
      for (let at = 0; at < body.length; at += size) {
        sent = at + size
        yield body.subarray(at, at + size)
      }
    }
    const got: string[] = []
    for await (const l of chunkLines(gunzipStream(pieces(997)))) got.push(l)
    expect(got).toEqual(lines)
    // A reader that stops early stops the input too.
    for await (const _ of chunkLines(gunzipStream(pieces(64)))) break
    expect(sent).toBeLessThan(body.length)
    // Bad input fails the read.
    async function* junk() {
      yield new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    }
    await expect(async () => {
      for await (const _ of gunzipStream(junk())) void _
    }).rejects.toThrow()
  })
})
