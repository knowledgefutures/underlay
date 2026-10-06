/**
 * Staging: what the next `underlay commit` will contain. Records go through the
 * same input rules and schema validation as the registry's ingest, so what
 * stages here is what a push will accept.
 */
import { createReadStream, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import {
  checkSchema,
  compileSchema,
  InputRuleError,
  isPrivateSchema,
  keys,
  parseRecordLine,
  recordCanonical,
  sha256Hex,
  stripToSchema,
} from '@underlay/protocol'

import { CliError, type Local, type StagedOp } from '../local.js'
import { versionState } from '../state.js'

export type Say = (line: string) => void

/** The schemas the next commit will have: staged, else the head's. */
export async function currentSchemas(
  local: Local,
): Promise<Record<string, Record<string, unknown>>> {
  const staged = local.stagedSchemas()
  if (staged) return staged
  const head = local.headVersion()
  return head ? (await versionState(local, head)).schemas : {}
}

/** Stage the full type set from a JSON file `{slug: schema, …}`. */
export async function schemaSet(local: Local, file: string, say: Say): Promise<void> {
  const schemas = JSON.parse(readFileSync(resolve(file), 'utf8')) as unknown
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) {
    throw new CliError('A schema file is an object of type → schema')
  }
  const out: Record<string, Record<string, unknown>> = {}
  for (const [slug, body] of Object.entries(schemas)) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new CliError(`Schema "${slug}" must be an object`)
    }
    const err = checkSchema(slug, body)
    if (err) throw new CliError(err)
    compileSchema(body)
    await local.repo.putSchema(body)
    out[slug] = body as Record<string, unknown>
  }
  if (Object.keys(out).length === 0) throw new CliError('The schema file defines no types')
  local.stageSchemas(out)
  say(`Staged ${Object.keys(out).length} type(s): ${Object.keys(out).join(', ')}`)
}

export interface AddOptions {
  /** Drop fields the schema doesn't define instead of refusing the record. */
  stripUnknownFields?: boolean
}

/** Stage upserts from an NDJSON file of `{id, type, data, private?}`. */
export async function add(local: Local, file: string, opts: AddOptions, say: Say): Promise<number> {
  const schemas = await currentSchemas(local)
  if (Object.keys(schemas).length === 0) {
    throw new CliError('No schemas yet. Stage them first with `underlay schema-set`.')
  }
  const errors: string[] = []
  const ops: StagedOp[] = []
  let line = 0
  const rl = createInterface({ input: createReadStream(resolve(file)), crlfDelay: Infinity })
  for await (const text of rl) {
    line++
    if (text.trim() === '') continue
    try {
      const rec = parseRecordLine(text)
      const schema = schemas[rec.type]
      if (!schema) throw new CliError(`No schema for type "${rec.type}"`)
      let { data, canonical } = rec
      const props = schema.properties as Record<string, unknown> | undefined
      if (props && data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const extra = Object.keys(data).filter((k) => !(k in props))
        if (extra.length > 0) {
          if (!opts.stripUnknownFields) {
            throw new CliError(
              `Fields not in the schema: ${extra.join(', ')} (use --strip-unknown-fields to drop them)`,
            )
          }
          data = stripToSchema(data as Record<string, unknown>, props)
          canonical = recordCanonical(rec.id, rec.type, data)
        }
      }
      const errs = compileSchema(schema)(data)
      if (errs.length > 0) throw new CliError(errs.join('; '))
      const isPrivate = rec.private === true && !isPrivateSchema(schema)
      ops.push({
        op: 'put',
        type: rec.type,
        id: rec.id,
        canonical,
        ...(isPrivate ? { private: true as const } : {}),
      })
    } catch (err) {
      if (!(err instanceof CliError || err instanceof InputRuleError)) throw err
      if (errors.length < 20) errors.push(`line ${line}: ${err.message}`)
      else if (errors.length === 20) errors.push('…')
    }
  }
  if (errors.length > 0)
    throw new CliError(`Nothing staged; invalid records:\n  ${errors.join('\n  ')}`)
  local.stageOps(ops)
  say(`Staged ${ops.length} record(s)`)
  return ops.length
}

/** Stage deletes of records by type and id. */
export function rm(local: Local, type: string, ids: string[], say: Say): void {
  if (ids.length === 0) throw new CliError('Name at least one record id')
  local.stageOps(ids.map((id) => ({ op: 'del' as const, type, id })))
  say(`Staged ${ids.length} delete(s)`)
}

/** Stage the version metadata from a JSON object file, or clear it. */
export function metaSet(local: Local, file: string | null, say: Say): void {
  if (file === null) {
    local.stageMetadata(null)
    say('Staged: no metadata')
    return
  }
  const value = JSON.parse(readFileSync(resolve(file), 'utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('Metadata must be a JSON object')
  }
  local.stageMetadata(value as Record<string, unknown>)
  say('Staged metadata')
}

/** Store files in the local repository, so records can reference them. */
export async function fileAdd(local: Local, paths: string[], say: Say): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    const bytes = new Uint8Array(readFileSync(resolve(p)))
    const hash = sha256Hex(bytes)
    await local.repo.blobs.put(keys.file(hash), bytes, { ifAbsent: true })
    say(`${p}: {"$file":"sha256:${hash}"}`)
    out.push(hash)
  }
  return out
}
