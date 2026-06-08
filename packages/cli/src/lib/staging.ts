import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { underlayDir } from './store.js'

function stagingDir(root: string): string {
  return join(underlayDir(root), 'staging')
}

export function getStagedSchema(root: string): Record<string, unknown> | null {
  const p = join(stagingDir(root), 'schema.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
}

export function setStagedSchema(root: string, schemas: Record<string, unknown>): void {
  writeFileSync(join(stagingDir(root), 'schema.json'), JSON.stringify(schemas, null, 2), 'utf-8')
}

export function getStagedRecords(root: string): string[] {
  const p = join(stagingDir(root), 'records.jsonl')
  if (!existsSync(p)) return []
  const content = readFileSync(p, 'utf-8').trim()
  if (!content) return []
  return content.split('\n')
}

export function appendStagedRecords(root: string, lines: string[]): void {
  const p = join(stagingDir(root), 'records.jsonl')
  appendFileSync(p, lines.join('\n') + '\n', 'utf-8')
}

export function clearStaging(root: string): void {
  const schemaPath = join(stagingDir(root), 'schema.json')
  const recordsPath = join(stagingDir(root), 'records.jsonl')
  if (existsSync(schemaPath)) writeFileSync(schemaPath, '', 'utf-8')
  if (existsSync(recordsPath)) writeFileSync(recordsPath, '', 'utf-8')
}
