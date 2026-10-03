const encoder = new TextEncoder()

export function utf8(s: string): Uint8Array {
  return encoder.encode(s)
}

/** UTF-8 byte length of a well-formed string, without encoding it. */
export function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i)
    if (u < 0x80) bytes += 1
    else if (u < 0x800) bytes += 2
    else if (u >= 0xd800 && u <= 0xdbff && i + 1 < s.length) {
      // A surrogate pair is one 4-byte code point.
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/**
 * Compare two strings by their UTF-8 bytes, which is Unicode code point order.
 *
 * JavaScript's `<` and default `sort()` compare UTF-16 code units, and those
 * disagree with code point order exactly when one side has a surrogate
 * (U+10000 and up, stored as 0xD800–0xDFFF) and the other a code unit in
 * 0xE000–0xFFFF. At the first differing unit, remap so surrogates sort above the
 * rest of the BMP; everything else compares as is.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x !== y) {
      if (x >= 0xd800 && y >= 0xd800) return fixup(x) - fixup(y)
      return x - y
    }
  }
  return a.length - b.length
}

function fixup(u: number): number {
  if (u >= 0xe000) return u - 0x800
  if (u >= 0xd800) return u + 0x2000
  return u
}
