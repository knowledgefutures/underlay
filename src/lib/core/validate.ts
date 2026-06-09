import Ajv from 'ajv'
import addFormats from 'ajv-formats'

export const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)

const MAX_SCHEMA_BYTES = 256 * 1024
const MAX_PATTERN_LENGTH = 256

/**
 * Bound caller-supplied JSON Schemas before they are compiled and run
 * server-side: caps total size and the length of regex `pattern` values
 * (long patterns are the main catastrophic-backtracking ReDoS vector).
 * Returns an error message, or null if the schema set is acceptable.
 */
export function checkSchemaBounds(schemas: Record<string, unknown>): string | null {
  for (const [slug, body] of Object.entries(schemas)) {
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
