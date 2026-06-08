import type { SchemaEntry } from './types.js'

export function getPrivateTypes(schemaEntries: SchemaEntry[]): Set<string> {
  const types = new Set<string>()
  for (const entry of schemaEntries) {
    if ((entry.schema as any)?.private === true) types.add(entry.slug)
  }
  return types
}

export function getPrivateFields(typeSchema: Record<string, unknown>): Set<string> {
  const fields = new Set<string>()
  const props = typeSchema?.properties as Record<string, any> | undefined
  if (!props) return fields
  for (const [fieldName, fieldDef] of Object.entries(props)) {
    if (fieldDef?.private === true) fields.add(fieldName)
  }
  return fields
}

export function filterRecordData(data: unknown, privateFields: Set<string>): unknown {
  if (privateFields.size === 0 || typeof data !== 'object' || data === null) return data
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!privateFields.has(key)) filtered[key] = value
  }
  return filtered
}

export function filterTypeSchema(typeSchema: Record<string, unknown>): Record<string, unknown> {
  const props = typeSchema?.properties as Record<string, any> | undefined
  if (!props) return typeSchema
  const publicProps: Record<string, unknown> = {}
  for (const [fieldName, fieldDef] of Object.entries(props)) {
    if ((fieldDef as any)?.private === true) continue
    publicProps[fieldName] = fieldDef
  }
  const required = (typeSchema.required as string[] | undefined)?.filter(
    (f: string) => !((props[f] as any)?.private === true),
  )
  return { ...typeSchema, properties: publicProps, required }
}
