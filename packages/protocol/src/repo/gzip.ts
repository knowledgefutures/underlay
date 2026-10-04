/**
 * Gzip with the Web Streams compression API, and gunzip with native zlib where
 * the runtime has it.
 *
 * A large leaf body is several gzip members in one object (repository layout).
 * Node's zlib and its DecompressionStream read concatenated members; workerd's
 * DecompressionStream stops after the first and throws "Trailing bytes after
 * end of compressed data" (found on staging, 2026-10-04). Node and workerd
 * (nodejs_compat) both expose zlib through `process.getBuiltinModule`, so it is
 * used there; browsers fall back to DecompressionStream, which reads single-member
 * bodies only.
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
    : pipe(bytes, new DecompressionStream('gzip'))

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
