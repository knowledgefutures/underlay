/**
 * POSIX tar over Web Streams, for packs (sync) and exports. The writer is
 * pull-based, so a slow reader holds back storage reads instead of buffering
 * the archive; each entry's size must be known before its bytes, and long names
 * use a PAX extended header. The reader handles what the writer produces plus
 * ustar name prefixes, and skips other entry types.
 */
const enc = new TextEncoder()
const dec = new TextDecoder()
const BLOCK = 512

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0'
}

function header(name: string, size: number, type: '0' | 'x', mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK)
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off)
  put(name, 0, 100)
  put(octal(0o644, 8), 100, 8)
  put(octal(0, 8), 108, 8)
  put(octal(0, 8), 116, 8)
  put(octal(size, 12), 124, 12)
  put(octal(Math.floor(mtime / 1000), 12), 136, 12)
  put('        ', 148, 8) // checksum placeholder
  put(type, 156, 1)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  let sum = 0
  for (const b of h) sum += b
  put(octal(sum, 7) + ' ', 148, 8)
  return h
}

function pax(name: string): Uint8Array {
  // "<len> path=<name>\n", where <len> counts itself.
  const body = (n: number) => `${n} path=${name}\n`
  let len = enc.encode(body(0)).byteLength
  while (enc.encode(body(len)).byteLength !== len) len = enc.encode(body(len)).byteLength
  return enc.encode(body(len))
}

const pad = (size: number) => (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK))

export interface TarEntry {
  name: string
  size: number
  /** Produces exactly `size` bytes. */
  body: () => AsyncIterable<Uint8Array>
}

/** The archive's bytes, entry by entry. */
export async function* tarChunks(
  entries: AsyncIterable<TarEntry> | Iterable<TarEntry>,
  mtime = Date.now(),
): AsyncGenerator<Uint8Array> {
  for await (const e of entries as AsyncIterable<TarEntry>) {
    if (enc.encode(e.name).byteLength > 100) {
      const p = pax(e.name)
      yield header('PaxHeader', p.byteLength, 'x', mtime)
      yield p
      yield new Uint8Array(pad(p.byteLength))
    }
    yield header(e.name, e.size, '0', mtime)
    let written = 0
    for await (const chunk of e.body()) {
      written += chunk.byteLength
      yield chunk
    }
    if (written !== e.size)
      throw new Error(`tar: ${e.name} produced ${written} bytes, declared ${e.size}`)
    yield new Uint8Array(pad(e.size))
  }
  yield new Uint8Array(BLOCK * 2)
}

/** A tar stream that reads its entries only as fast as it is consumed. */
export function tarStream(
  entries: AsyncIterable<TarEntry> | Iterable<TarEntry>,
  mtime = Date.now(),
): ReadableStream<Uint8Array> {
  const it = tarChunks(entries, mtime)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (err) {
        controller.error(err)
      }
    },
    async cancel(reason) {
      await it.return?.(reason)
    },
  })
}

/** A tar entry read back: its name and all of its bytes. */
export interface TarFile {
  name: string
  bytes: Uint8Array
}

/** Reads exactly n bytes at a time from a chunked byte stream. */
class ByteReader {
  readonly #it: AsyncIterator<Uint8Array>
  #buf: Uint8Array = new Uint8Array(0)
  #at = 0
  constructor(src: AsyncIterable<Uint8Array>) {
    this.#it = src[Symbol.asyncIterator]()
  }
  /** n bytes, or null at a clean end of input. Throws on a truncated read. */
  async take(n: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      if (this.#at >= this.#buf.length) {
        const { value, done } = await this.#it.next()
        if (done) {
          if (filled === 0) return null
          throw new Error('tar: truncated archive')
        }
        this.#buf = value
        this.#at = 0
        continue
      }
      const k = Math.min(n - filled, this.#buf.length - this.#at)
      out.set(this.#buf.subarray(this.#at, this.#at + k), filled)
      this.#at += k
      filled += k
    }
    return out
  }
}

const str = (b: Uint8Array, off: number, len: number) => {
  const s = b.subarray(off, off + len)
  const end = s.indexOf(0)
  return dec.decode(end === -1 ? s : s.subarray(0, end))
}

async function* chunks(src: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>) {
  if (Symbol.asyncIterator in src) {
    yield* src as AsyncIterable<Uint8Array>
    return
  }
  const reader = (src as ReadableStream<Uint8Array>).getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * The regular files of a tar archive, in order. An entry over `maxEntryBytes`
 * is refused rather than buffered.
 */
export async function* untar(
  src: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  opts: { maxEntryBytes?: number } = {},
): AsyncGenerator<TarFile> {
  const max = opts.maxEntryBytes ?? 256 * 1024 * 1024
  const r = new ByteReader(chunks(src))
  let paxPath: string | null = null
  for (;;) {
    const h = await r.take(BLOCK)
    if (!h) throw new Error('tar: missing end-of-archive marker')
    if (h.every((b) => b === 0)) return
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
    if (sum !== parseInt(str(h, 148, 8).trim(), 8)) throw new Error('tar: bad header checksum')
    const size = parseInt(str(h, 124, 12).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('tar: bad entry size')
    if (size > max) throw new Error(`tar: entry of ${size} bytes is over the limit`)
    const type = String.fromCharCode(h[156]!)
    const body = (await r.take(size + pad(size))) ?? new Uint8Array(0)
    const bytes = body.subarray(0, size)
    if (type === 'x') {
      for (const rec of dec.decode(bytes).split('\n')) {
        const m = /^\d+ path=(.*)$/s.exec(rec)
        if (m) paxPath = m[1]!
      }
      continue
    }
    if (type !== '0' && type !== '\0') {
      paxPath = null
      continue
    }
    const prefix = str(h, 345, 155)
    const name = paxPath ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100))
    paxPath = null
    yield { name, bytes }
  }
}
