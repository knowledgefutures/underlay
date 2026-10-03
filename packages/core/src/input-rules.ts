/**
 * Input rules (protocol v2, "Input rules").
 *
 * `JSON.parse` silently changes some inputs: it rounds large integers, keeps only
 * the last of duplicate keys, and accepts lone UTF-16 surrogates. A record changed
 * that way is not what the client sent, and an implementation in another language
 * would hash something different. So v2 rejects such input, and it has to look at
 * the source text to do it: after parsing, `1e20` and `100000000000000000000` are
 * the same double and duplicate keys are gone.
 *
 * `scanJson` is a single pass over the text that checks the rules without building
 * values. `JSON.parse` still builds the value; the scan only rejects. Both the CLI
 * and the server run the same scan, so they accept exactly the same inputs.
 */
import {
  MAX_ID_BYTES,
  MAX_JSON_DEPTH,
  MAX_RECORD_BYTES,
  MAX_SAFE_INTEGER_LITERAL,
  MAX_TYPE_BYTES,
} from './constants.js'
import { recordCanonical } from './hash.js'
import { utf8ByteLength } from './utf8.js'

export type InputRuleCode =
  | 'syntax'
  | 'duplicate_key'
  | 'unsafe_integer'
  | 'lone_surrogate'
  | 'too_deep'
  | 'record_too_large'
  | 'bad_id'
  | 'bad_type'
  | 'bad_envelope'

export class InputRuleError extends Error {
  constructor(
    readonly code: InputRuleCode,
    message: string,
  ) {
    super(message)
    this.name = 'InputRuleError'
  }
}

const enum C {
  Quote = 0x22,
  Backslash = 0x5c,
  OpenBrace = 0x7b,
  CloseBrace = 0x7d,
  OpenBracket = 0x5b,
  CloseBracket = 0x5d,
  Comma = 0x2c,
  Colon = 0x3a,
  Minus = 0x2d,
  Zero = 0x30,
  Nine = 0x39,
  Dot = 0x2e,
  LowerE = 0x65,
  UpperE = 0x45,
  LowerU = 0x75,
}

interface Frame {
  isObject: boolean
  keys: Set<string> | null
  expectKey: boolean
}

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff

/**
 * Check `text` against the input rules: no duplicate object keys (compared after
 * unescaping), no integer literal outside ±(2^53 − 1), no lone surrogate (raw or
 * `\u`-escaped), nesting no deeper than `maxDepth` (each object or array is one
 * level). Throws InputRuleError on the first violation.
 *
 * Syntax is left to `JSON.parse`; on malformed input this may report a rule
 * violation instead of a syntax error, but it always terminates and never
 * accepts anything `JSON.parse` would reject.
 */
export function scanJson(text: string, maxDepth: number = MAX_JSON_DEPTH): void {
  const n = text.length
  const stack: Frame[] = []
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === C.Quote) {
      const start = i
      i++
      let escaped = false
      let pendingHigh = false
      for (;;) {
        if (i >= n) throw new InputRuleError('syntax', 'Unterminated string')
        let u = text.charCodeAt(i)
        if (u === C.Quote) break
        if (u === C.Backslash) {
          escaped = true
          const e = text.charCodeAt(i + 1)
          if (e === C.LowerU) {
            u = parseInt(text.slice(i + 2, i + 6), 16)
            if (Number.isNaN(u)) throw new InputRuleError('syntax', 'Bad \\u escape')
            i += 6
          } else {
            u = 0 // any other escape is a non-surrogate code unit
            i += 2
          }
        } else {
          i++
        }
        if (pendingHigh) {
          if (isLow(u)) {
            pendingHigh = false
            continue
          }
          throw new InputRuleError('lone_surrogate', 'Lone UTF-16 surrogate in string')
        }
        if (isHigh(u)) pendingHigh = true
        else if (isLow(u))
          throw new InputRuleError('lone_surrogate', 'Lone UTF-16 surrogate in string')
      }
      if (pendingHigh) throw new InputRuleError('lone_surrogate', 'Lone UTF-16 surrogate in string')
      i++ // closing quote
      const top = stack[stack.length - 1]
      if (top?.isObject && top.expectKey) {
        const raw = text.slice(start + 1, i - 1)
        const key = escaped ? (JSON.parse(text.slice(start, i)) as string) : raw
        top.keys ??= new Set()
        if (top.keys.has(key)) {
          throw new InputRuleError('duplicate_key', `Duplicate object key ${JSON.stringify(key)}`)
        }
        top.keys.add(key)
        top.expectKey = false
      }
      continue
    }
    if (c === C.OpenBrace || c === C.OpenBracket) {
      if (stack.length >= maxDepth) {
        throw new InputRuleError('too_deep', `JSON nested deeper than ${maxDepth} levels`)
      }
      stack.push({ isObject: c === C.OpenBrace, keys: null, expectKey: c === C.OpenBrace })
      i++
      continue
    }
    if (c === C.CloseBrace || c === C.CloseBracket) {
      stack.pop()
      i++
      continue
    }
    if (c === C.Comma) {
      const top = stack[stack.length - 1]
      if (top?.isObject) top.expectKey = true
      i++
      continue
    }
    if (c === C.Minus || (c >= C.Zero && c <= C.Nine)) {
      let j = c === C.Minus ? i + 1 : i
      const digitsStart = j
      while (j < n && text.charCodeAt(j) >= C.Zero && text.charCodeAt(j) <= C.Nine) j++
      const next = text.charCodeAt(j)
      const isInteger = next !== C.Dot && next !== C.LowerE && next !== C.UpperE
      if (isInteger) {
        const len = j - digitsStart
        const max = MAX_SAFE_INTEGER_LITERAL
        if (len > max.length || (len === max.length && text.slice(digitsStart, j) > max)) {
          throw new InputRuleError(
            'unsafe_integer',
            `Integer ${text.slice(i, j)} is outside ±(2^53−1); send large integers as strings`,
          )
        }
        i = j
      } else {
        // Fraction and/or exponent: skip the rest of the number token.
        j++
        while (j < n) {
          const d = text.charCodeAt(j)
          if (
            (d >= C.Zero && d <= C.Nine) ||
            d === 0x2b ||
            d === C.Minus ||
            d === C.LowerE ||
            d === C.UpperE ||
            d === C.Dot
          )
            j++
          else break
        }
        i = j
      }
      continue
    }
    // Whitespace, colon, and the literals true/false/null.
    i++
  }
}

/** `scanJson` then `JSON.parse`. Throws InputRuleError (code `syntax` for parse errors). */
export function parseStrict(text: string, maxDepth: number = MAX_JSON_DEPTH): unknown {
  scanJson(text, maxDepth)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new InputRuleError('syntax', `Invalid JSON: ${(err as Error).message}`)
  }
}

export interface RecordInput {
  id: string
  type: string
  data: unknown
  private?: boolean
}

/** Check a record id against the protocol limits. Returns an error message or null. */
export function checkRecordId(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) return 'Record id must be a non-empty string'
  if (utf8ByteLength(id) > MAX_ID_BYTES) return `Record id exceeds ${MAX_ID_BYTES} bytes`
  return null
}

/**
 * Check a type slug. Slugs become export entry names (`records/<type>.ndjson`),
 * so path separators, control characters and a leading dot are refused.
 */
export function checkTypeSlug(type: unknown): string | null {
  if (typeof type !== 'string' || type.length === 0) return 'Type must be a non-empty string'
  if (utf8ByteLength(type) > MAX_TYPE_BYTES) return `Type exceeds ${MAX_TYPE_BYTES} bytes`
  if (type.startsWith('.')) return 'Type must not start with "."'
  for (let i = 0; i < type.length; i++) {
    const u = type.charCodeAt(i)
    if (u === 0x2f || u === 0x5c || u < 0x20 || u === 0x7f) {
      return 'Type must not contain slashes or control characters'
    }
  }
  return null
}

/**
 * Parse one pushed record line, `{"id":…,"type":…,"data":…,"private"?:…}`, under
 * the input rules. The envelope counts as one nesting level, so `data` may nest
 * MAX_JSON_DEPTH levels deep. Size is checked on the canonical form, which is what
 * is stored and hashed; the canonical string is returned so callers don't build it
 * twice.
 */
export function parseRecordLine(line: string): RecordInput & { canonical: string } {
  const value = parseStrict(line, MAX_JSON_DEPTH + 1)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputRuleError('bad_envelope', 'Record must be a JSON object')
  }
  const rec = value as Record<string, unknown>
  const idError = checkRecordId(rec.id)
  if (idError) throw new InputRuleError('bad_id', idError)
  const typeError = checkTypeSlug(rec.type)
  if (typeError) throw new InputRuleError('bad_type', typeError)
  if (!('data' in rec)) throw new InputRuleError('bad_envelope', 'Record is missing "data"')
  if (rec.private !== undefined && typeof rec.private !== 'boolean') {
    throw new InputRuleError('bad_envelope', '"private" must be a boolean')
  }
  const canonical = recordCanonical(rec.id as string, rec.type as string, rec.data)
  if (utf8ByteLength(canonical) > MAX_RECORD_BYTES) {
    throw new InputRuleError('record_too_large', `Record exceeds ${MAX_RECORD_BYTES} bytes`)
  }
  const out: RecordInput & { canonical: string } = {
    id: rec.id as string,
    type: rec.type as string,
    data: rec.data,
    canonical,
  }
  if (rec.private !== undefined) out.private = rec.private as boolean
  return out
}
