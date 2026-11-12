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

/** Room above a member's stated length: a runtime grows its output a chunk at a time. */
const INFLATE_STEP = 65_536

/**
 * Inflate one block, refusing one that inflates past `maxBytes`: a block's stored length
 * says nothing of what it holds, and a few hundred KB of zeros inflate to hundreds of MB.
 *
 * The limit given to zlib is sized from the member's own trailer, which states its
 * inflated length (ISIZE, RFC 1952), not from `maxBytes`: on Cloudflare Workers a call
 * costs time in proportion to the limit it is given, and a reader makes one for every
 * block. A member that states more than `maxBytes` is refused unread. One that inflates
 * past what it states stops at that limit; it is then tried once more at `maxBytes` (a
 * runtime may also need more room than the stated length), and refused if it passes that.
 * Where a runtime does not stop at the limit, the result is still refused.
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
  const stated =
    bytes.byteLength >= 4
      ? new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 4, 4).getUint32(0, true)
      : 0
  if (stated > maxBytes) throw tooLong()
  const room = Math.min(maxBytes, (Math.ceil(stated / INFLATE_STEP) + 1) * INFLATE_STEP)
  const inflate = (limit: number) =>
    new Promise<Uint8Array>((resolve, reject) =>
      zlib.gunzip(bytes, { maxOutputLength: limit }, (err, out) =>
        err ? reject(err) : resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)),
      ),
    )
  // Node says ERR_BUFFER_TOO_LARGE; workerd, a RangeError "Memory limit exceeded".
  const pastLimit = (err: Error & { code?: string }) =>
    err.code === 'ERR_BUFFER_TOO_LARGE' || /memory limit|too large/i.test(err.message)
  let out: Uint8Array
  try {
    out = await inflate(room)
  } catch (first) {
    if (!pastLimit(first as Error)) throw notGzip(first as Error)
    if (room === maxBytes) throw tooLong()
    out = await inflate(maxBytes).catch((err: Error) => {
      throw pastLimit(err) ? tooLong() : notGzip(err)
    })
  }
  if (out.byteLength > maxBytes) throw tooLong()
  return out
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
