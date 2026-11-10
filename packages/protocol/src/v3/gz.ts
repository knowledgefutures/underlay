/**
 * Gzip for sorted-record-files: one member per block. Native zlib where the
 * runtime has it (Node, Workers with nodejs_compat), with a level; the Web
 * Streams compressor elsewhere. Nothing hashed depends on the compressed bytes,
 * so the two, and any level, give the same file ids.
 */
import { gunzip as gunzipAny, gzip as gzipWeb } from '../repo/gzip.js'

interface Zlib {
  gzip(
    bytes: Uint8Array,
    opts: { level?: number },
    done: (err: Error | null, out: Uint8Array) => void,
  ): void
}
const zlib = (
  globalThis as { process?: { getBuiltinModule?: (id: 'node:zlib') => Zlib | undefined } }
).process?.getBuiltinModule?.('node:zlib')

/** One gzip member. `level` (1 to 9) is used where zlib is native; the default is zlib's (6). */
export function gzipMember(bytes: Uint8Array, level?: number): Promise<Uint8Array> {
  if (!zlib) return gzipWeb(bytes)
  return new Promise((resolve, reject) =>
    zlib.gzip(bytes, level === undefined ? {} : { level }, (err, out) =>
      err ? reject(err) : resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)),
    ),
  )
}

export const gunzipMember = gunzipAny

export function concatBytes(parts: readonly Uint8Array[], total?: number): Uint8Array {
  if (parts.length === 1) return parts[0]!
  const out = new Uint8Array(total ?? parts.reduce((n, p) => n + p.byteLength, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}
