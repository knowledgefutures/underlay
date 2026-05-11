import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { eq, } from 'drizzle-orm'
import { createHash, } from 'node:crypto'
import { db, schema, } from '../db/client.server.js'

export const ajv = new Ajv({ allErrors: true, strict: false, },)
addFormats(ajv,)

export type SchemaEntry = {
  slug: string
  schemaId: string
  schema: Record<string, unknown>
  schemaHash: string
}

/** Load the full schema set for a version (slug → schema body + metadata) */
export async function loadVersionSchemas(versionId: number,): Promise<SchemaEntry[]> {
  const rows = await db
    .select({
      slug: schema.versionSchemas.slug,
      schemaId: schema.versionSchemas.schemaId,
      schema: schema.schemas.schema,
      schemaHash: schema.schemas.schemaHash,
    },)
    .from(schema.versionSchemas,)
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id,),)
    .where(eq(schema.versionSchemas.versionId, versionId,),)

  return rows as SchemaEntry[]
}

/** Get the set of private type slugs from a version's schemas */
export function getPrivateTypes(schemaEntries: SchemaEntry[],): Set<string> {
  const types = new Set<string>()
  for (const entry of schemaEntries) {
    if ((entry.schema as any)?.private === true) types.add(entry.slug,)
  }
  return types
}

/** Get the set of private field names for a given type schema */
export function getPrivateFields(typeSchema: Record<string, unknown>,): Set<string> {
  const fields = new Set<string>()
  const props = typeSchema?.properties as Record<string, any> | undefined
  if (!props) return fields
  for (const [fieldName, fieldDef,] of Object.entries(props,)) {
    if (fieldDef?.private === true) fields.add(fieldName,)
  }
  return fields
}

/** Strip private fields from a record's data */
export function filterRecordData(data: unknown, privateFields: Set<string>,): unknown {
  if (privateFields.size === 0 || typeof data !== 'object' || data === null) return data
  const filtered: Record<string, unknown> = {}
  for (const [key, value,] of Object.entries(data as Record<string, unknown>,)) {
    if (!privateFields.has(key,)) filtered[key] = value
  }
  return filtered
}

/** Filter a type schema for public view: strip private fields from properties */
export function filterTypeSchema(typeSchema: Record<string, unknown>,): Record<string, unknown> {
  const props = typeSchema?.properties as Record<string, any> | undefined
  if (!props) return typeSchema
  const publicProps: Record<string, unknown> = {}
  for (const [fieldName, fieldDef,] of Object.entries(props,)) {
    if ((fieldDef as any)?.private === true) continue
    publicProps[fieldName] = fieldDef
  }
  const required = (typeSchema.required as string[] | undefined)?.filter(
    (f: string,) => !((props[f] as any)?.private === true),
  )
  return { ...typeSchema, properties: publicProps, required, }
}

/** Compute SHA-256 hash of a schema JSON body (canonical stringified) */
export function hashSchema(schemaBody: unknown,): string {
  return createHash('sha256',).update(JSON.stringify(schemaBody,),).digest('hex',)
}

/** Derive next semver from previous, based on what changed */
export function deriveSemver(
  prevSemver: string | null,
  schemaChanged: boolean,
  recordsChanged: boolean,
): string {
  if (!prevSemver) return 'v1.0.0'
  const parts = prevSemver.replace(/^v/, '',).split('.',).map(Number,)
  const [major, minor, patch,] = [parts[0] ?? 1, parts[1] ?? 0, parts[2] ?? 0,]
  if (schemaChanged) return `v${major + 1}.0.0`
  if (recordsChanged) return `v${major}.${minor + 1}.0`
  return `v${major}.${minor}.${patch + 1}`
}
