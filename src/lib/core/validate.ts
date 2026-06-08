import Ajv from 'ajv'
import addFormats from 'ajv-formats'

export const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)

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
