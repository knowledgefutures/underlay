/**
 * Record validation against type schemas (protocol v2, section 5).
 *
 * v1 validated with AJV, which compiles every schema to JavaScript with
 * `new Function`. Cloudflare Workers forbid that, so v2 uses
 * @cfworker/json-schema, which interprets the schema and never evaluates code.
 * The dialect is v1's, and scripts/diff-validators.ts checks the two agree on
 * every production schema and record:
 *
 * - JSON Schema draft-07. A root `$schema`, if present, must name draft-07.
 * - Keywords next to `$ref` are applied, as AJV does (draft-07 says to ignore them).
 * - Keywords draft-07 doesn't define are ignored. That includes later drafts'
 *   keywords, which @cfworker/json-schema would otherwise enforce in any draft.
 * - `format` constrains strings only, with ajv-formats' definitions (see
 *   AJV_FORMATS below), kept apart from the library's own table. Unknown
 *   formats are ignored.
 * - A schema must itself be valid against the draft-07 meta-schema, every
 *   `pattern` must be a valid Unicode (`u` flag) regex, and every `$ref` must
 *   resolve inside the schema; all three are checked when it is compiled.
 */
import {
  deepCompareStrict,
  dereference,
  format as formats,
  validate as interpret,
  type OutputUnit,
  type Schema,
} from '@cfworker/json-schema'

import { MAX_SCHEMA_BYTES } from './constants.js'
import { hashSchema } from './hash.js'
import { checkTypeSlug } from './input-rules.js'
import { jcs } from './jcs.js'
import { utf8ByteLength } from './utf8.js'

/** Longest `pattern` (or `patternProperties` key) accepted: long patterns are the main ReDoS vector. */
const MAX_PATTERN_LENGTH = 256
const MAX_CACHED_VALIDATORS = 500

/** A schema that can't be compiled: not valid draft-07, or an unresolvable `$ref`. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

/** Validate one record's `data`. Returns `"<instance path> <message>"` strings; empty means valid. */
export type SchemaValidator = (data: unknown) => string[]

type Lookup = Record<string, Schema | boolean>

// Fixed rather than the library default, which is the page URL in a browser:
// relative `$id`s and `$ref`s must resolve the same everywhere.
const BASE_URI = new URL('https://schema.underlay.invalid/')

const META_ID = 'http://json-schema.org/draft-07/schema'
const DRAFT_07 = new Set([
  'http://json-schema.org/draft-07/schema',
  'http://json-schema.org/draft-07/schema#',
])

// Keywords whose values are maps from a name to a subschema: the names are data,
// not keywords, so a property called "prefixItems" must survive `toDialect`.
const MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependencies',
])
// Keywords whose values are instance data, never schemas.
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples', 'required', 'type'])
// Keywords @cfworker/json-schema implements but draft-07 (and so AJV) ignores.
// `id` is draft-04's `$id`; the library honours it, AJV's draft-07 does not.
const NOT_DRAFT_07 = [
  'id',
  '$recursiveRef',
  '$recursiveAnchor',
  'unevaluatedProperties',
  'unevaluatedItems',
  'dependentRequired',
  'dependentSchemas',
  'prefixItems',
  'minContains',
  'maxContains',
]

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

// --- Compile ------------------------------------------------------------------

// Schemas are content-addressed, so compiled validators are keyed by schema
// hash: every push parses its schemas afresh, and identity would never hit.
const validatorCache = new Map<string, SchemaValidator>()

/**
 * Compile a type schema, reusing the validator for identical schema content.
 * Throws SchemaError if the schema is not valid draft-07 or a `$ref` doesn't
 * resolve. Run `checkSchema` first: this does not bound size or patterns.
 */
export function compileSchema(schema: unknown): SchemaValidator {
  let key: string
  let validator: SchemaValidator
  try {
    key = hashSchema(schema)
    const cached = validatorCache.get(key)
    if (cached) return cached
    validator = build(schema)
  } catch (err) {
    // Every compile step recurses over the schema; a deeply nested one
    // overflows the stack, which is a bad schema, not a server error.
    if (err instanceof SchemaError) throw err
    throw new SchemaError(`schema could not be compiled: ${(err as Error).message}`)
  }
  if (validatorCache.size >= MAX_CACHED_VALIDATORS) {
    const oldest = validatorCache.keys().next().value
    if (oldest !== undefined) validatorCache.delete(oldest)
  }
  validatorCache.set(key, validator)
  return validator
}

function build(schema: unknown): SchemaValidator {
  // Boolean schemas are fine below the root, but a type's schema is an object:
  // v1 could not compile `true` or `false` there either.
  if (!isObject(schema)) throw new SchemaError('schema must be an object')
  if (schema.$schema !== undefined && !DRAFT_07.has(schema.$schema as string)) {
    throw new SchemaError(
      `unsupported $schema ${JSON.stringify(schema.$schema)}: schemas must be JSON Schema draft-07`,
    )
  }
  // A bare copy: the library tests membership with `in`, and annotates the
  // schema objects it is given.
  const body = bare(schema) as Schema
  registerFormats()
  const meta = interpret(body, META_SCHEMA, '7', META_LOOKUP, true)
  if (!meta.valid) {
    throw new SchemaError(
      `schema is invalid: ${messages(meta.errors, META_SCHEMA, META_LOOKUP, body).join(', ')}`,
    )
  }
  // The meta-schema's `regex` format accepts what `new RegExp(p)` accepts, but
  // patterns run with the `u` flag (as in AJV), which is stricter.
  const badPattern = findBadPattern(body)
  if (badPattern) throw new SchemaError(badPattern)

  toDialect(body)
  // Seeded with the meta-schema, which AJV also resolves `$ref`s to.
  const lookup: Lookup = Object.assign(Object.create(null) as Lookup, META_LOOKUP)
  try {
    dereference(body, lookup, BASE_URI)
  } catch (err) {
    throw new SchemaError((err as Error).message)
  }
  // The library only finds a dangling `$ref` when a record reaches it; AJV
  // refused the schema up front, and so does v2.
  for (const sub of Object.values(lookup)) {
    if (typeof sub === 'object' && typeof sub.$ref === 'string') {
      if (lookup[sub.__absolute_ref__ ?? sub.$ref] === undefined) {
        throw new SchemaError(`can't resolve reference ${sub.$ref}`)
      }
    }
  }

  // Short-circuiting stops a `properties` or `items` loop at its first failure.
  // It never changes the verdict, only how many errors come back, so it is off
  // where it is safe: AJV (v1) reported every error. It is unsafe in schemas
  // with keywords whose failing branches are explored and thrown away: each
  // such branch re-validates its whole subtree, which is exponential in depth
  // on recursive schemas. A 567 KB production record under a recursive `oneOf`
  // schema took 1.5 ms short-circuited and did not finish otherwise (AJV with
  // allErrors, as v1 ran it, took 7 s). A `$ref` to the meta-schema brings
  // its `anyOf`s in.
  const refsMeta = Object.entries(lookup).some(
    ([uri, sub]) =>
      !uri.startsWith(META_ID) &&
      typeof sub === 'object' &&
      !!sub.__absolute_ref__?.startsWith(META_ID),
  )
  const shortCircuit = refsMeta || hasBranching(body)

  return (data) => {
    try {
      const instance = bare(data)
      // '2019-09' only changes `$ref` handling here (siblings are applied); the
      // later-draft keywords it would add were removed by `toDialect`.
      const result = interpret(instance, body, '2019-09', lookup, shortCircuit)
      if (result.valid) return []
      // The verdict is the library's. A message we fail to word must never turn
      // an invalid record into a valid one.
      const out = messages(result.errors, body, lookup, instance)
      return out.length > 0 ? out : ['/ must match the schema']
    } catch (err) {
      // A schema that recurses without consuming data, e.g. `{"$ref":"#"}`,
      // overflows the stack. Report it against the record, don't crash the push.
      return [`/ schema could not be applied: ${(err as Error).message}`]
    }
  }
}

/**
 * A deep copy whose objects have no prototype. The library tests membership
 * with `in`, so on ordinary objects `required: ["toString"]` would pass for `{}`
 * and `properties: {"constructor": …}` would be checked against `Object`.
 */
function bare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(bare)
  if (value === null || typeof value !== 'object') return value
  const out = Object.create(null) as Record<string, unknown>
  for (const [k, v] of Object.entries(value)) out[k] = bare(v)
  return out
}

const BRANCHING = new Set(['anyOf', 'oneOf', 'not', 'if', 'contains'])

/** Whether a schema uses a keyword that validates and discards a failing branch. */
function hasBranching(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasBranching)
  if (!isObject(node)) return false
  for (const [k, v] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(k)) continue
    if (BRANCHING.has(k)) return true
    if (
      MAP_KEYWORDS.has(k) && isObject(v) ? Object.values(v).some(hasBranching) : hasBranching(v)
    ) {
      return true
    }
  }
  return false
}

/**
 * Remove, in place, the keywords @cfworker/json-schema honours but draft-07
 * doesn't, and point formats at the dialect's definitions.
 */
function toDialect(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) toDialect(item)
    return
  }
  if (!isObject(node)) return
  for (const k of NOT_DRAFT_07) delete node[k]
  namespaceFormat(node)
  for (const [k, v] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(k)) continue
    if (MAP_KEYWORDS.has(k) && isObject(v)) {
      for (const sub of Object.values(v)) toDialect(sub)
    } else {
      toDialect(v)
    }
  }
}

function findBadPattern(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findBadPattern(item)
      if (found) return found
    }
    return null
  }
  if (!isObject(node)) return null
  const patterns: unknown[] = [node.pattern]
  if (isObject(node.patternProperties)) patterns.push(...Object.keys(node.patternProperties))
  for (const p of patterns) {
    if (typeof p !== 'string') continue
    try {
      new RegExp(p, 'u')
    } catch (err) {
      return `pattern ${JSON.stringify(p)} is invalid: ${(err as Error).message}`
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(k)) continue
    const found =
      MAP_KEYWORDS.has(k) && isObject(v) ? findBadPattern(Object.values(v)) : findBadPattern(v)
    if (found) return found
  }
  return null
}

// --- Formats ------------------------------------------------------------------
//
// v1 used ajv-formats in "full" mode. @cfworker/json-schema's formats agree with
// it on date, uri, uri-reference, uri-template, url, uuid, hostname, ipv6 and the
// JSON pointer formats, but differ on the ones below, so these are ajv-formats'
// definitions (MIT, https://github.com/ajv-validator/ajv-formats), installed in
// the library's format table. ajv-formats' number formats (int32, int64, float,
// double) are not carried over: the library applies `format` to strings only.
// No production schema uses them.

const isLeapYear = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
function date(str: string): boolean {
  const m = DATE.exec(str)
  if (!m) return false
  const year = +m[1]!
  const month = +m[2]!
  const day = +m[3]!
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]!)
  )
}

const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i
function time(strictTimeZone: boolean) {
  return (str: string): boolean => {
    const m = TIME.exec(str)
    if (!m) return false
    const hr = +m[1]!
    const min = +m[2]!
    const sec = +m[3]!
    const tz = m[4]
    const tzSign = m[5] === '-' ? -1 : 1
    const tzH = +(m[6] || 0)
    const tzM = +(m[7] || 0)
    if (tzH > 23 || tzM > 59 || (strictTimeZone && !tz)) return false
    if (hr <= 23 && min <= 59 && sec < 60) return true
    // A leap second is valid only at 23:59:60 UTC.
    const utcMin = min - tzM * tzSign
    const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0)
    return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61
  }
}

const DATE_TIME_SEPARATOR = /t|\s/i
function dateTime(strictTimeZone: boolean) {
  const t = time(strictTimeZone)
  return (str: string): boolean => {
    const parts = str.split(DATE_TIME_SEPARATOR)
    return parts.length === 2 && date(parts[0]!) && t(parts[1]!)
  }
}

const Z_ANCHOR = /[^\\]\\Z/
function regex(str: string): boolean {
  if (Z_ANCHOR.test(str)) return false
  try {
    new RegExp(str)
    return true
  } catch {
    return false
  }
}

const matches = (re: RegExp) => (str: string) => re.test(str)

const AJV_FORMATS: Record<string, (s: string) => boolean> = {
  date,
  time: time(true),
  'date-time': dateTime(true),
  'iso-time': time(false),
  'iso-date-time': dateTime(false),
  duration: matches(/^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/),
  email: matches(
    /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
  ),
  ipv4: matches(
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
  ),
  regex,
  // `m` as in ajv-formats, quirk included: a string passes if any one line does.
  byte: matches(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/m),
}

// The library reads formats from one shared table, with no per-validator
// option. Overwriting its entries would change validation for any other user of
// the library in the same bundle, so the dialect's formats are registered under
// their own names (`underlay:date`, …) on first compile, and our copy of each
// schema points at those (`namespaceFormat`). Formats the dialect doesn't know
// are dropped from the copy: they are ignored, and a name like `hasOwnProperty`
// never reaches the table's prototype.
const FORMAT_PREFIX = 'underlay:'
const DIALECT_FORMATS: Record<string, (s: string) => boolean> = Object.assign(
  Object.create(null) as Record<string, (s: string) => boolean>,
  Object.fromEntries(Object.entries(formats).filter(([k]) => !k.startsWith(FORMAT_PREFIX))),
  AJV_FORMATS,
)
let formatsRegistered = false
function registerFormats(): void {
  if (formatsRegistered) return
  const table = formats as Record<string, (s: string) => boolean>
  for (const [name, check] of Object.entries(DIALECT_FORMATS)) table[FORMAT_PREFIX + name] = check
  formatsRegistered = true
}

/** In our copy of a schema node: point `format` at the dialect's definition, or drop it. */
function namespaceFormat(node: Record<string, unknown>): void {
  if (typeof node.format !== 'string') return
  if (Object.hasOwn(DIALECT_FORMATS, node.format)) node.format = FORMAT_PREFIX + node.format
  else delete node.format
}

// --- Messages -----------------------------------------------------------------
//
// AJV's wording, which v1 clients have seen: `${instancePath || '/'} ${message}`.
// The library reports wrapper errors ("A subschema had errors.") above each
// leaf; AJV reports only the leaves, so wrappers are dropped.

function messages(
  errors: OutputUnit[],
  root: Schema | boolean,
  lookup: Lookup,
  instance: unknown,
): string[] {
  const out: string[] = []
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i]!
    const message = describe(e, root, lookup, instance)
    if (message !== null) out.push(`${instancePath(e.instanceLocation)} ${message}`)
    // `additionalProperties: false` is reported by AJV once, on the object. The
    // library follows its wrapper with a "False boolean schema" leaf for the
    // property, whose keywordLocation is (wrongly) the instance location, so it
    // can only be recognised by position.
    const additional = e.keyword === 'additionalProperties' || e.keyword === 'additionalItems'
    if (additional && message !== null && errors[i + 1]?.keyword === 'false') i++
    // A property name's own errors follow its wrapper, located at the property;
    // AJV locates them at the object.
    if (e.keyword === 'propertyNames') {
      const name = /^Property name "(.*)" does/s.exec(e.error)?.[1] ?? ''
      const at = `${e.instanceLocation}/${encodeURI(escapeSegment(name))}`
      while (errors[i + 1]?.instanceLocation === at) {
        const leaf = errors[++i]!
        const leafMessage = describe(leaf, root, lookup, instance)
        if (leafMessage !== null) out.push(`${instancePath(e.instanceLocation)} ${leafMessage}`)
      }
    }
  }
  return out
}

function describe(
  e: OutputUnit,
  root: Schema | boolean,
  lookup: Lookup,
  instance: unknown,
): string | null {
  const value = () => schemaAt(e.keywordLocation, root, lookup)
  const quoted = (re: RegExp) => re.exec(e.error)?.slice(1) ?? []
  switch (e.keyword) {
    case '$ref':
    case 'properties':
    case 'patternProperties':
    case 'items':
    case 'allOf':
      return null
    case 'false':
      return 'boolean schema is false'
    case 'additionalProperties':
      return value() === false ? 'must NOT have additional properties' : null
    case 'additionalItems': {
      if (value() !== false) return null
      const items = schemaAt(e.keywordLocation.replace(/additionalItems$/, 'items'), root, lookup)
      return `must NOT have more than ${Array.isArray(items) ? items.length : 0} items`
    }
    case 'dependencies': {
      const [key] = quoted(/^Instance has "(.*)" but does not have ".*"\.$/s)
      if (key === undefined) return null // the schema form: its leaves carry the errors
      const deps = (value() as Record<string, unknown> | undefined)?.[key]
      const list = Array.isArray(deps) ? deps : []
      return `must have ${list.length === 1 ? 'property' : 'properties'} ${list.join(', ')} when property ${key} is present`
    }
    case 'type': {
      const t = value()
      return `must be ${Array.isArray(t) ? t.join(',') : String(t)}`
    }
    case 'required':
      return `must have required property '${quoted(/property "(.*)"\.$/s)[0]}'`
    case 'const':
      return 'must be equal to constant'
    case 'enum':
      return 'must be equal to one of the allowed values'
    case 'not':
      return 'must NOT be valid'
    case 'anyOf':
      return 'must match a schema in anyOf'
    case 'oneOf':
      return 'must match exactly one schema in oneOf'
    case 'if':
      return e.error.includes('"then"') ? 'must match "then" schema' : 'must match "else" schema'
    case 'propertyNames':
      return 'property name must be valid'
    case 'contains':
      return 'must contain at least 1 valid item(s)'
    case 'uniqueItems': {
      // AJV names the last duplicate pair; the library, the first.
      const items = valueAt(e.instanceLocation, instance)
      if (Array.isArray(items)) {
        for (let i = items.length - 1; i > 0; i--) {
          for (let j = i - 1; j >= 0; j--) {
            if (deepCompareStrict(items[i], items[j])) {
              return `must NOT have duplicate items (items ## ${j} and ${i} are identical)`
            }
          }
        }
      }
      return 'must NOT have duplicate items'
    }
    case 'minimum':
      return `must be >= ${String(value())}`
    case 'maximum':
      return `must be <= ${String(value())}`
    case 'exclusiveMinimum':
      return `must be > ${String(value())}`
    case 'exclusiveMaximum':
      return `must be < ${String(value())}`
    case 'multipleOf':
      return `must be multiple of ${String(value())}`
    case 'minLength':
      return `must NOT have fewer than ${String(value())} characters`
    case 'maxLength':
      return `must NOT have more than ${String(value())} characters`
    case 'minItems':
      return `must NOT have fewer than ${String(value())} items`
    case 'maxItems':
      return `must NOT have more than ${String(value())} items`
    case 'minProperties':
      return `must NOT have fewer than ${String(value())} properties`
    case 'maxProperties':
      return `must NOT have more than ${String(value())} properties`
    case 'pattern':
      return `must match pattern "${String(value())}"`
    case 'format':
      return `must match format "${String(value()).slice(FORMAT_PREFIX.length)}"`
    default:
      return e.error
  }
}

// The library writes locations as `#` plus JSON Pointer segments passed through
// encodeURI; AJV's instancePath is the plain JSON Pointer.
function instancePath(location: string): string {
  let path = location.slice(1)
  try {
    path = decodeURI(path)
  } catch {
    // keep it encoded
  }
  return path || '/'
}

const unescapeSegment = (s: string) => {
  try {
    s = decodeURI(s)
  } catch {
    // keep it encoded
  }
  return s.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** The instance value at an instance location. */
function valueAt(location: string, root: unknown): unknown {
  let node = root
  for (const raw of location.split('/').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[unescapeSegment(raw)]
  }
  return node
}

/** The schema value at a keyword location, following `$ref` segments through the lookup. */
function schemaAt(location: string, root: Schema | boolean, lookup: Lookup): unknown {
  let node: unknown = root
  let inMap = false
  for (const raw of location.split('/').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined
    const seg = unescapeSegment(raw)
    const obj = node as Schema
    if (!inMap && seg === '$ref' && typeof obj.$ref === 'string') {
      node = lookup[obj.__absolute_ref__ ?? obj.$ref]
      continue
    }
    node = (node as Record<string, unknown>)[seg]
    inMap = !inMap && MAP_KEYWORDS.has(seg)
  }
  return node
}

// --- Bounds and v2 rules -----------------------------------------------------

/**
 * Check every schema in a push: see `checkSchema`. Returns the first error
 * message, or null if all are acceptable.
 */
export function checkSchemaBounds(schemas: Record<string, unknown>): string | null {
  for (const [slug, body] of Object.entries(schemas)) {
    const error = checkSchema(slug, body)
    if (error) return error
  }
  return null
}

/**
 * Bound a caller-supplied schema before it is compiled and run server-side, and
 * apply the v2 schema rules:
 *
 * - the type slug passes `checkTypeSlug`;
 * - the canonical (JCS) schema is at most MAX_SCHEMA_BYTES;
 * - no `pattern` or `patternProperties` key is longer than 256 characters;
 * - a root `private`, if present, is a boolean;
 * - no property is marked `"private": true`. v1 stripped such fields from
 *   public views; v2 has no field-level privacy, and accepting the marker
 *   would publish a field its author meant to hide.
 *
 * Returns an error message, or null if the schema is acceptable.
 */
export function checkSchema(slug: string, body: unknown): string | null {
  const slugError = checkTypeSlug(slug)
  if (slugError) return `Invalid type slug ${JSON.stringify(slug)}: ${slugError}`
  let canonical: string
  try {
    canonical = jcs(body)
  } catch (err) {
    return `Schema "${slug}" is not JSON: ${(err as Error).message}`
  }
  if (utf8ByteLength(canonical) > MAX_SCHEMA_BYTES) {
    return `Schema "${slug}" exceeds maximum size of ${MAX_SCHEMA_BYTES} bytes`
  }
  const longPattern = findLongPattern(body)
  if (longPattern) {
    return `Schema "${slug}" has a ${longPattern} longer than ${MAX_PATTERN_LENGTH} characters`
  }
  if (isObject(body) && body.private !== undefined && typeof body.private !== 'boolean') {
    return `Schema "${slug}": "private" must be a boolean`
  }
  const privateField = findPrivateField(body, '')
  if (privateField !== null) {
    return (
      `Schema "${slug}" marks property ${privateField} as private: field-level privacy ` +
      'is not supported; make the whole type private instead'
    )
  }
  return null
}

function findLongPattern(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findLongPattern(item)
      if (found) return found
    }
    return null
  }
  if (!isObject(node)) return null
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' && typeof value === 'string' && value.length > MAX_PATTERN_LENGTH) {
      return '"pattern"'
    }
    // Keys of patternProperties are regexes too; v1 didn't bound them.
    if (key === 'patternProperties' && isObject(value)) {
      if (Object.keys(value).some((p) => p.length > MAX_PATTERN_LENGTH)) {
        return '"patternProperties" pattern'
      }
    }
    const found = findLongPattern(value)
    if (found) return found
  }
  return null
}

/**
 * The JSON Pointer of the first property schema with `"private": true`, at any
 * depth: nested markers never did anything in v1 either, and are refused
 * for the same reason.
 */
function findPrivateField(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = findPrivateField(node[i], `${path}/${i}`)
      if (found !== null) return found
    }
    return null
  }
  if (!isObject(node)) return null
  for (const [k, v] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(k)) continue
    const at = `${path}/${escapeSegment(k)}`
    if (k === 'properties' && isObject(v)) {
      for (const [name, sub] of Object.entries(v)) {
        const subPath = `${at}/${escapeSegment(name)}`
        if (isObject(sub) && sub.private === true) return JSON.stringify(subPath)
        const found = findPrivateField(sub, subPath)
        if (found !== null) return found
      }
      continue
    }
    const found = findPrivateField(v, at)
    if (found !== null) return found
  }
  return null
}

const escapeSegment = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1')

// --- Extra fields -------------------------------------------------------------

export interface ExtraFieldWarning {
  recordId: string
  type: string
  fields: string[]
}

/** Records with top-level fields their type's schema doesn't list in `properties`. */
export function findExtraFields(
  records: { recordId: string; type: string; data: unknown }[],
  schemas: Record<string, { properties?: Record<string, unknown> }>,
): ExtraFieldWarning[] {
  const warnings: ExtraFieldWarning[] = []
  for (const rec of records) {
    const props = schemas[rec.type]?.properties
    if (!props || typeof rec.data !== 'object' || rec.data === null) continue
    const extra = Object.keys(rec.data).filter((k) => !Object.hasOwn(props, k))
    if (extra.length > 0) warnings.push({ recordId: rec.recordId, type: rec.type, fields: extra })
  }
  return warnings
}

/** `data` without the top-level fields that `schemaProperties` doesn't list. */
export function stripToSchema(
  data: Record<string, unknown>,
  schemaProperties: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(data)) {
    if (Object.hasOwn(schemaProperties, key)) result[key] = data[key]
  }
  return result
}

// --- Draft-07 meta-schema -----------------------------------------------------
//
// http://json-schema.org/draft-07/schema, verbatim. AJV checks every schema
// against it before compiling; without the check a schema such as
// `{"type": "text"}` would compile and then reject every record.

const META_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'http://json-schema.org/draft-07/schema#',
  title: 'Core schema meta-schema',
  definitions: {
    schemaArray: { type: 'array', minItems: 1, items: { $ref: '#' } },
    nonNegativeInteger: { type: 'integer', minimum: 0 },
    nonNegativeIntegerDefault0: {
      allOf: [{ $ref: '#/definitions/nonNegativeInteger' }, { default: 0 }],
    },
    simpleTypes: { enum: ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'] },
    stringArray: { type: 'array', items: { type: 'string' }, uniqueItems: true, default: [] },
  },
  type: ['object', 'boolean'],
  properties: {
    $id: { type: 'string', format: 'uri-reference' },
    $schema: { type: 'string', format: 'uri' },
    $ref: { type: 'string', format: 'uri-reference' },
    $comment: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    default: true,
    readOnly: { type: 'boolean', default: false },
    examples: { type: 'array', items: true },
    multipleOf: { type: 'number', exclusiveMinimum: 0 },
    maximum: { type: 'number' },
    exclusiveMaximum: { type: 'number' },
    minimum: { type: 'number' },
    exclusiveMinimum: { type: 'number' },
    maxLength: { $ref: '#/definitions/nonNegativeInteger' },
    minLength: { $ref: '#/definitions/nonNegativeIntegerDefault0' },
    pattern: { type: 'string', format: 'regex' },
    additionalItems: { $ref: '#' },
    items: { anyOf: [{ $ref: '#' }, { $ref: '#/definitions/schemaArray' }], default: true },
    maxItems: { $ref: '#/definitions/nonNegativeInteger' },
    minItems: { $ref: '#/definitions/nonNegativeIntegerDefault0' },
    uniqueItems: { type: 'boolean', default: false },
    contains: { $ref: '#' },
    maxProperties: { $ref: '#/definitions/nonNegativeInteger' },
    minProperties: { $ref: '#/definitions/nonNegativeIntegerDefault0' },
    required: { $ref: '#/definitions/stringArray' },
    additionalProperties: { $ref: '#' },
    definitions: { type: 'object', additionalProperties: { $ref: '#' }, default: {} },
    properties: { type: 'object', additionalProperties: { $ref: '#' }, default: {} },
    patternProperties: {
      type: 'object',
      additionalProperties: { $ref: '#' },
      propertyNames: { format: 'regex' },
      default: {},
    },
    dependencies: {
      type: 'object',
      additionalProperties: { anyOf: [{ $ref: '#' }, { $ref: '#/definitions/stringArray' }] },
    },
    propertyNames: { $ref: '#' },
    const: true,
    enum: { type: 'array', items: true, minItems: 1, uniqueItems: true },
    type: {
      anyOf: [
        { $ref: '#/definitions/simpleTypes' },
        {
          type: 'array',
          items: { $ref: '#/definitions/simpleTypes' },
          minItems: 1,
          uniqueItems: true,
        },
      ],
    },
    format: { type: 'string' },
    contentMediaType: { type: 'string' },
    contentEncoding: { type: 'string' },
    if: { $ref: '#' },
    then: { $ref: '#' },
    else: { $ref: '#' },
    allOf: { $ref: '#/definitions/schemaArray' },
    anyOf: { $ref: '#/definitions/schemaArray' },
    oneOf: { $ref: '#/definitions/schemaArray' },
    not: { $ref: '#' },
  },
  default: true,
}

// The meta-schema's formats (uri, uri-reference, regex) are the dialect's too.
toDialect(META_SCHEMA)
const META_LOOKUP: Lookup = dereference(META_SCHEMA, Object.create(null) as Lookup, BASE_URI)
