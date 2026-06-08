import { createHash } from 'node:crypto'

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return sorted
}

export function hashSchema(schemaBody: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(schemaBody)))
    .digest('hex')
}

export function hashRecord(record: { id: string; type: string; data: unknown }): {
  hash: string
  canonical: string
} {
  const canonical = JSON.stringify({
    id: record.id,
    type: record.type,
    data: canonicalize(record.data),
  })
  const hash = createHash('sha256').update(canonical).digest('hex')
  return { hash, canonical }
}
