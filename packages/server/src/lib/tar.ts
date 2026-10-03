/**
 * A streaming tar writer over Web Streams (Workers and Node). Each entry's size
 * must be known before its bytes; long names use a PAX extended header.
 */
const enc = new TextEncoder()
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

export function tarStream(
  entries: AsyncIterable<TarEntry> | Iterable<TarEntry>,
  mtime = Date.now(),
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const e of entries as AsyncIterable<TarEntry>) {
          const nameBytes = enc.encode(e.name)
          if (nameBytes.byteLength > 100) {
            const p = pax(e.name)
            controller.enqueue(header('PaxHeader', p.byteLength, 'x', mtime))
            controller.enqueue(p)
            controller.enqueue(new Uint8Array(pad(p.byteLength)))
          }
          controller.enqueue(header(e.name, e.size, '0', mtime))
          let written = 0
          for await (const chunk of e.body()) {
            written += chunk.byteLength
            controller.enqueue(chunk)
          }
          if (written !== e.size)
            throw new Error(`tar: ${e.name} produced ${written} bytes, declared ${e.size}`)
          controller.enqueue(new Uint8Array(pad(e.size)))
        }
        controller.enqueue(new Uint8Array(BLOCK * 2))
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}
