/**
 * Gzip for sorted-record-files: one member per block. Native zlib where the
 * runtime has it (Node, Workers with nodejs_compat), with a level; the Web
 * Streams compressor elsewhere. Nothing hashed depends on the compressed bytes,
 * so the two, and any level, give the same file ids.
 */
import { gunzip as gunzipAny, gzip as gzipWeb } from '../repo/gzip.js'
import { FormatError } from './lines.js'

interface Zlib {
  gzip(
    bytes: Uint8Array,
    opts: { level?: number },
    done: (err: Error | null, out: Uint8Array) => void,
  ): void
  gunzip(
    bytes: Uint8Array,
    opts: { maxOutputLength?: number },
    done: (err: (Error & { code?: string }) | null, out: Uint8Array) => void,
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

/**
 * Inflate one block, refusing one that inflates past `maxBytes`: a block's stored length
 * says nothing of what it holds, and a few hundred KB of zeros inflate to hundreds of MB.
 * Native zlib stops at the limit; where a runtime does not, the result is still refused.
 */
export async function gunzipMember(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const tooLong = () => new FormatError(`A block inflates past ${maxBytes} bytes`)
  const notGzip = (err: Error) => new FormatError(`A block does not inflate: ${err.message}`)
  if (!zlib) {
    const out = await gunzipAny(bytes).catch((err) => {
      throw notGzip(err as Error)
    })
    if (out.byteLength > maxBytes) throw tooLong()
    return out
  }
  return new Promise((resolve, reject) =>
    zlib.gunzip(bytes, { maxOutputLength: maxBytes }, (err, out) => {
      if (err) return reject(err.code === 'ERR_BUFFER_TOO_LARGE' ? tooLong() : notGzip(err))
      if (out.byteLength > maxBytes) return reject(tooLong())
      resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength))
    }),
  )
}

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
