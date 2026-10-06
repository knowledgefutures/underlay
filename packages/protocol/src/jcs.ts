/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * JCS is `JSON.stringify` for every primitive (ECMAScript number formatting and
 * string escaping) plus object keys sorted by UTF-16 code units. The one trap is
 * JavaScript objects themselves: they enumerate integer-like keys ("9", "10")
 * first, in numeric order, whatever order they were inserted in. So "sort the keys
 * into a new object, then stringify" cannot produce sorted output for those keys.
 * This writes objects out as strings instead, and never relies on enumeration
 * order.
 *
 * Inputs come from JSON, so they never hold `undefined`, functions, bigints or
 * non-finite numbers. Those throw rather than serialize to something a different
 * implementation would not produce.
 */
export function jcs(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite number')
      // JSON.stringify renders -0 as "0", which is what JCS requires.
      return JSON.stringify(value)
    case 'object': {
      if (value === null) return 'null'
      if (Array.isArray(value)) {
        let out = '['
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out += ','
          out += jcs(value[i])
        }
        return out + ']'
      }
      const o = value as Record<string, unknown>
      // Array.prototype.sort() with no comparator compares UTF-16 code units,
      // which is exactly JCS's key order.
      const keys = Object.keys(o).sort()
      let out = '{'
      let first = true
      for (const k of keys) {
        const v = o[k]
        if (v === undefined) continue
        if (!first) out += ','
        first = false
        out += JSON.stringify(k) + ':' + jcs(v)
      }
      return out + '}'
    }
    default:
      throw new TypeError(`JCS: cannot serialize ${typeof value}`)
  }
}
