import Ajv from 'ajv'
import addFormats from 'ajv-formats'

import { hashSchema } from './hash.js'

export const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)

type Validator = ReturnType<typeof ajv.compile>

// Ajv caches compiled schemas by object identity, and every push batch parses
// its schemas afresh — so calling ajv.compile() per batch recompiled each type
// on the event loop and retained every copy for the life of the process.
// Schemas are content-addressed, so key compiled validators by schema hash.
const MAX_CACHED_VALIDATORS = 500
const validatorCache = new Map<string, Validator>()

/** Compile a JSON Schema, reusing the validator for identical schema content. */
export function compileSchema(schemaBody: object): Validator {
  const key = hashSchema(schemaBody)
  const cached = validatorCache.get(key)
  if (cached) return cached
  const validate = ajv.compile(schemaBody)
  // Ajv's own identity cache would otherwise keep this copy alive too.
  ajv.removeSchema(schemaBody)
  if (validatorCache.size >= MAX_CACHED_VALIDATORS) {
    const oldest = validatorCache.keys().next().value
    if (oldest !== undefined) validatorCache.delete(oldest)
  }
  validatorCache.set(key, validate)
  return validate
}

const MAX_SCHEMA_BYTES = 256 * 1024
const MAX_PATTERN_LENGTH = 256

const MAX_TYPE_SLUG_LENGTH = 128
// No path separators, control characters, or leading dot: type slugs become
// export archive entry names (`records/<type>.ndjson`).
const hasUnsafeChar = (s: string) =>
  [...s].some((ch) => ch === '/' || ch === '\\' || ch.charCodeAt(0) < 0x20 || ch === '\x7f')

/** Returns an error message, or null if the type slug is safe to use in file names. */
export function checkTypeSlug(slug: string): string | null {
  if (slug.length === 0 || slug.length > MAX_TYPE_SLUG_LENGTH) {
    return `Type slug must be 1-${MAX_TYPE_SLUG_LENGTH} characters`
  }
  if (slug.startsWith('.') || hasUnsafeChar(slug)) {
    return `Type slug "${slug}" must not start with "." or contain slashes or control characters`
  }
  return null
}

/**
 * Bound caller-supplied JSON Schemas before they are compiled and run
 * server-side: caps total size and the length of regex `pattern` values
 * (long patterns are the main catastrophic-backtracking ReDoS vector).
 * Returns an error message, or null if the schema set is acceptable.
 */
export function checkSchemaBounds(schemas: Record<string, unknown>): string | null {
  for (const [slug, body] of Object.entries(schemas)) {
    const slugError = checkTypeSlug(slug)
    if (slugError) return slugError
    const json = JSON.stringify(body)
    if (json.length > MAX_SCHEMA_BYTES) {
      return `Schema "${slug}" exceeds maximum size of ${MAX_SCHEMA_BYTES} bytes`
    }
    const longPattern = findLongPattern(body)
    if (longPattern !== null) {
      return `Schema "${slug}" has a "pattern" longer than ${MAX_PATTERN_LENGTH} characters`
    }
  }
  return null
}

function findLongPattern(node: unknown): string | null {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findLongPattern(item)
      if (found !== null) return found
    }
    return null
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'pattern' && typeof value === 'string' && value.length > MAX_PATTERN_LENGTH) {
      return value
    }
    const found = findLongPattern(value)
    if (found !== null) return found
  }
  return null
}

export interface ExtraFieldWarning {
  recordId: string
  type: string
  fields: string[]
}

export function findExtraFields(
  records: { recordId: string; type: string; data: unknown }[],
  schemas: Record<string, { properties?: Record<string, unknown> }>,
): ExtraFieldWarning[] {
  const warnings: ExtraFieldWarning[] = []
  for (const rec of records) {
    const typeSchema = schemas[rec.type]
    if (!typeSchema?.properties || typeof rec.data !== 'object' || rec.data === null) continue
    const extra = Object.keys(rec.data).filter((k) => !(k in typeSchema.properties!))
    if (extra.length > 0) {
      warnings.push({ recordId: rec.recordId, type: rec.type, fields: extra })
    }
  }
  return warnings
}

export function stripToSchema(
  data: Record<string, unknown>,
  schemaProperties: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(data)) {
    if (key in schemaProperties) {
      result[key] = data[key]
    }
  }
  return result
}
