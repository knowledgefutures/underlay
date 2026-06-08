import { createHash } from 'node:crypto'

export function hashSchema(schemaBody: unknown): string {
  return createHash('sha256').update(JSON.stringify(schemaBody)).digest('hex')
}

export function hashRecord(record: { id: string; type: string; data: unknown }): {
  hash: string
  canonical: string
} {
  const canonical = JSON.stringify({ id: record.id, type: record.type, data: record.data })
  const hash = createHash('sha256').update(canonical).digest('hex')
  return { hash, canonical }
}
