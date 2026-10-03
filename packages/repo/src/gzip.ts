/** Gzip with the Web Streams compression API (Workers and Node alike). */

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

export const gunzip = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream('gzip'))

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
