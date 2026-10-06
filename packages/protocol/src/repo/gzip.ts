/**
 * Gzip with the Web Streams compression API, and gunzip with native zlib where
 * the runtime has it.
 *
 * A large leaf body is several gzip members in one object (repository layout).
 * Node's zlib and its DecompressionStream read concatenated members; workerd's
 * DecompressionStream stops after the first and throws "Trailing bytes after
 * end of compressed data" (found on staging, 2026-10-04). Node and workerd
 * (nodejs_compat) both expose zlib through `process.getBuiltinModule`, so it is
 * used there. Browsers use DecompressionStream, which may stop after one member,
 * so their path splits the members itself (gunzipMembers).
 */

async function pipe(
  bytes: Uint8Array,
  t: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export const gzip = (data: Uint8Array | string) =>
  pipe(typeof data === 'string' ? enc.encode(data) : data, new CompressionStream('gzip'))

interface Zlib {
  gunzip(bytes: Uint8Array, done: (err: Error | null, out: Uint8Array) => void): void
}
const zlib = (
  globalThis as { process?: { getBuiltinModule?: (id: 'node:zlib') => Zlib | undefined } }
).process?.getBuiltinModule?.('node:zlib')

export const gunzip = (bytes: Uint8Array): Promise<Uint8Array> =>
  zlib
    ? new Promise((resolve, reject) =>
        zlib.gunzip(bytes, (err, out) =>
          err ? reject(err) : resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)),
        ),
      )
    : gunzipMembers(bytes, (b) => pipe(b, new DecompressionStream('gzip')))

/**
 * Gunzip with a decompressor that may read only one member (browsers'
 * DecompressionStream). Whole input first; if that fails, the members are found
 * one at a time: a member ends where a later gzip header starts and the bytes
 * up to it decode on their own (a slice cut anywhere else is truncated or has
 * trailing bytes). Exported for the test that stands in a one-member decoder.
 */
export async function gunzipMembers(
  bytes: Uint8Array,
  oneMember: (b: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  try {
    return await oneMember(bytes)
  } catch (first) {
    const parts: Uint8Array[] = []
    let start = 0
    next: while (start < bytes.length) {
      // A member is at least an 18-byte header and trailer.
      for (let end = start + 18; end <= bytes.length; end++) {
        const atHeader =
          end === bytes.length ||
          (bytes[end] === 0x1f && bytes[end + 1] === 0x8b && bytes[end + 2] === 0x08)
        if (!atHeader) continue
        try {
          parts.push(await oneMember(bytes.subarray(start, end)))
          start = end
          continue next
        } catch {
          // Not this member's end: a header inside compressed data.
        }
      }
      throw first
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.byteLength
    }
    return out
  }
}

export const gunzipText = async (bytes: Uint8Array) => dec.decode(await gunzip(bytes))

export const isGzip = (bytes: Uint8Array) =>
  bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b

/** Split decompressed NDJSON into lines (a trailing newline ends the last line). */
export function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
