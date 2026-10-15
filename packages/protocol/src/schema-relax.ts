/**
 * Is a schema change one that can't make a valid record invalid? Then a commit
 * needn't revalidate the type's records, which is O(type size).
 *
 * `after` relaxes `before` when the two are the same schema except for:
 *
 *   - `required` lists that lose names, where loosening can only accept more
 *     (not under `not`, `oneOf`, `if`, `definitions` or `$defs`: there a looser
 *     subschema can reject a record, or be reached from anywhere by `$ref`);
 *   - annotations: `title`, `description`, `$comment`;
 *   - the root's `private` flag, which says which set records go in, not what
 *     they hold.
 *
 * A schema with a `$ref` gets only the annotation and `private` allowances: a
 * reference can reach a subschema from under `not`. Everything else must be
 * equal (JCS). False means "revalidate", never "invalid".
 */
import { jcs } from './jcs.js'

const ANNOTATIONS = new Set(['title', 'description', '$comment'])
/** Keywords whose value is a map of name → subschema, each in a monotone position. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties'])
/** Keywords whose value is one subschema in a monotone position. */
const SCHEMA_ONE = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'contains',
  'propertyNames',
  'then',
  'else',
])
/** Keywords whose value is a list of subschemas in monotone positions. */
const SCHEMA_LIST = new Set(['allOf', 'anyOf', 'items'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : jcs(a) === jcs(b)

function hasRef(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasRef)
  if (!isObject(v)) return false
  return Object.entries(v).some(([k, x]) => k === '$ref' || hasRef(x))
}

export function schemaRelaxes(before: unknown, after: unknown): boolean {
  return relaxes(before, after, true, !hasRef(before) && !hasRef(after))
}

function relaxes(a: unknown, b: unknown, root: boolean, loosen: boolean): boolean {
  if (!isObject(a) || !isObject(b)) return same(a, b)
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ANNOTATIONS.has(k) || (root && k === 'private')) continue
    const x = a[k]
    const y = b[k]
    if (k === 'required' && loosen) {
      const was = x === undefined ? [] : x
      const now = y === undefined ? [] : y
      if (!Array.isArray(was) || !Array.isArray(now)) return false
      if (!now.every((n) => was.includes(n))) return false
      continue
    }
    if (SCHEMA_MAPS.has(k) && isObject(x) && isObject(y)) {
      if (!same(Object.keys(x).sort(), Object.keys(y).sort())) return false
      for (const name of Object.keys(x)) if (!relaxes(x[name], y[name], false, loosen)) return false
      continue
    }
    if (SCHEMA_LIST.has(k) && Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false
      for (let i = 0; i < x.length; i++) if (!relaxes(x[i], y[i], false, loosen)) return false
      continue
    }
    if (SCHEMA_ONE.has(k) && isObject(x) && isObject(y)) {
      if (!relaxes(x, y, false, loosen)) return false
      continue
    }
    // Everything else, including `not`, `oneOf`, `if` and definitions, must be equal.
    if (!same(x, y)) return false
  }
  return true
}
