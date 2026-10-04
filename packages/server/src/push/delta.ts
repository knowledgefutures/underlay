/**
 * Delta push: the path at scale. A session names a base version and uploads
 * upserts (records) and deletes; the commit costs O(changes).
 *
 * Record lines go through the input rules, schema validation and canonical
 * hashing at upload, so commit never re-reads them. Large records are stored out
 * of line in the collection's repository right away, so runs stay small.
 */
import {
  compileSchema,
  emptySet,
  InputRuleError,
  OUT_OF_LINE_BYTES,
  parseRecordLine,
  recordCanonical,
  sha256Hex,
  stripToSchema,
  utf8ByteLength,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import {
  type BaseVersion,
  commitVersion,
  type CommitResult,
  type TypeInput,
} from '../versions/commit.js'
import { deltaChanges, isPrivateSchema } from './changes.js'
import { planParallel } from './parallel.js'
import { type RunEntry, type RunIndex, writeRun } from './runs.js'
import {
  loadInputs,
  nextRunSeq,
  recordRun,
  schemaHashes,
  type SessionInputs,
  sessionRuns,
  type SessionRow,
  transition,
} from './session.js'

export const MAX_BATCH_BYTES = 16 * 1024 * 1024
export const MAX_BATCH_LINES = 10_000
const MAX_REPORTED = 100

export interface LineError {
  line: number
  recordId?: string
  type?: string
  errors: string[]
}

export type IngestResult =
  | { ok: true; received: number }
  | { ok: false; status: 400 | 409 | 422; error: string; details?: LineError[]; total?: number }

function lines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().length > 0)
}

/**
 * Parse, validate and hash one batch of record lines into run entries, a line at
 * a time as they arrive (a string is split first). More than MAX_BATCH_LINES
 * lines stops the batch with `tooManyLines`.
 */
export async function prepareRecords(
  ports: Ports,
  collectionId: string,
  inputs: SessionInputs,
  input: string | AsyncIterable<string>,
  opts: {
    stripUnknownFields: boolean
    /** Adjust each entry, given the record's data as sent (negotiate adds legacy hashes). */
    entryOf?: (e: RunEntry, data: unknown) => RunEntry
  },
): Promise<
  { entries: RunEntry[] } | { errors: LineError[]; total: number } | { tooManyLines: true }
> {
  const errors: LineError[] = []
  let total = 0
  const fail = (e: LineError) => {
    total++
    if (errors.length < MAX_REPORTED) errors.push(e)
  }
  const entries: RunEntry[] = []
  const repo = await ports.stores.forCollection(collectionId)
  const source = typeof input === 'string' ? lines(input) : input
  let i = -1
  for await (const line of source) {
    i++
    if (i >= MAX_BATCH_LINES) return { tooManyLines: true }
    let rec
    try {
      rec = parseRecordLine(line)
    } catch (err) {
      if (!(err instanceof InputRuleError)) throw err
      fail({ line: i + 1, errors: [`${err.code}: ${err.message}`] })
      continue
    }
    const typeSchema = inputs.schemas[rec.type]
    if (!typeSchema) {
      fail({
        line: i + 1,
        recordId: rec.id,
        type: rec.type,
        errors: [`No schema for type "${rec.type}"`],
      })
      continue
    }
    let data = rec.data
    let canonical = rec.canonical
    const props = typeSchema.properties as Record<string, unknown> | undefined
    if (props && data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const extra = Object.keys(data).filter((k) => !(k in props))
      if (extra.length > 0) {
        if (!opts.stripUnknownFields) {
          fail({
            line: i + 1,
            recordId: rec.id,
            type: rec.type,
            errors: [
              `Fields not in the schema: ${extra.join(', ')} (set strip_unknown_fields to drop them)`,
            ],
          })
          continue
        }
        data = stripToSchema(data as Record<string, unknown>, props)
        canonical = recordCanonical(rec.id, rec.type, data)
      }
    }
    const errs = compileSchema(typeSchema)(data)
    if (errs.length > 0) {
      fail({ line: i + 1, recordId: rec.id, type: rec.type, errors: errs })
      continue
    }
    const hash = sha256Hex(canonical)
    const size = utf8ByteLength(canonical)
    const body = size > OUT_OF_LINE_BYTES ? await repo.putOutOfLine(hash, canonical) : canonical
    const isPrivate = isPrivateSchema(typeSchema) || rec.private === true
    const entry: RunEntry = {
      t: rec.type,
      k: rec.id,
      h: hash,
      s: size,
      b: body,
      ...(isPrivate ? { p: true } : {}),
    }
    entries.push(opts.entryOf ? opts.entryOf(entry, rec.data) : entry)
  }
  return total > 0 ? { errors, total } : { entries }
}

export async function ingestRecords(
  ports: Ports,
  session: SessionRow,
  input: string | AsyncIterable<string>,
): Promise<IngestResult> {
  const inputs = await loadInputs(ports, session.id)
  const prepared = await prepareRecords(ports, session.collectionId, inputs, input, {
    stripUnknownFields: session.stripUnknownFields,
  })
  if ('tooManyLines' in prepared) {
    return { ok: false, status: 400, error: `At most ${MAX_BATCH_LINES} records per batch` }
  }
  if ('errors' in prepared) {
    return {
      ok: false,
      status: 422,
      error: 'Invalid records',
      details: prepared.errors,
      total: prepared.total,
    }
  }
  if (prepared.entries.length === 0) return { ok: false, status: 400, error: 'Empty batch' }
  const seq = await nextRunSeq(ports, session.id)
  if (seq === null) return { ok: false, status: 409, error: 'Session is not open' }
  const index = await writeRun(ports.stores.internal, session.id, seq, prepared.entries)
  await recordRun(ports, session.id, 'records', index, { records: prepared.entries.length })
  return { ok: true, received: prepared.entries.length }
}

export async function ingestDeletes(
  ports: Ports,
  session: SessionRow,
  text: string,
): Promise<IngestResult> {
  const inputs = await loadInputs(ports, session.id)
  const entries: RunEntry[] = []
  const errors: LineError[] = []
  const all = lines(text)
  if (all.length > MAX_BATCH_LINES)
    return { ok: false, status: 400, error: `At most ${MAX_BATCH_LINES} deletes per batch` }
  all.forEach((l, i) => {
    let v: { type?: unknown; id?: unknown }
    try {
      v = JSON.parse(l) as typeof v
    } catch {
      errors.push({ line: i + 1, errors: ['Invalid JSON'] })
      return
    }
    if (typeof v.type !== 'string' || typeof v.id !== 'string') {
      errors.push({ line: i + 1, errors: ['Each line is {"type": …, "id": …}'] })
    } else if (!inputs.schemas[v.type]) {
      errors.push({ line: i + 1, errors: [`No schema for type "${v.type}"`] })
    } else {
      entries.push({ t: v.type, k: v.id, x: true })
    }
  })
  if (errors.length > 0)
    return {
      ok: false,
      status: 422,
      error: 'Invalid deletes',
      details: errors.slice(0, MAX_REPORTED),
      total: errors.length,
    }
  if (entries.length === 0) return { ok: false, status: 400, error: 'Empty batch' }
  const seq = await nextRunSeq(ports, session.id)
  if (seq === null) return { ok: false, status: 409, error: 'Session is not open' }
  const index = await writeRun(ports.stores.internal, session.id, seq, entries)
  await recordRun(ports, session.id, 'deletes', index, {})
  return { ok: true, received: entries.length }
}

/** The base a session commits on, from the collection head. */
export async function headBase(ports: Ports, collectionId: string): Promise<BaseVersion | null> {
  const [row] = await ports.db
    .select({ v: schema.versions })
    .from(schema.collections)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
    .where(eq(schema.collections.id, collectionId))
    .limit(1)
  return row ? asBase(row.v) : null
}

/** A version by id as a commit base (null for none). */
export async function versionBase(
  ports: Ports,
  versionId: string | null,
): Promise<BaseVersion | null> {
  if (!versionId) return null
  const [v] = await ports.db.select().from(schema.versions).where(eq(schema.versions.id, versionId))
  return v ? asBase(v) : null
}

function asBase(v: typeof schema.versions.$inferSelect): BaseVersion {
  return {
    id: v.id,
    seq: v.seq,
    semver: v.semver,
    hash: v.hash,
    publicRefsRoot: v.publicRefsRoot,
    privateRefsRoot: v.privateRefsRoot,
  }
}

/** Change streams for a delta session: per type, the merged runs split into the two sets. */
async function typeInputsForDelta(
  ports: Ports,
  session: SessionRow,
  inputs: SessionInputs,
  runs: RunIndex[],
  base: {
    pub: Record<string, { root: string | null }>
    priv: Record<string, { root: string | null }>
  },
): Promise<TypeInput[]> {
  const internal = ports.stores.internal
  const hashes = schemaHashes(inputs.schemas)
  return Object.entries(inputs.schemas).map(([slug, s]) => {
    const privateType = isPrivateSchema(s)
    const sets = { pub: !!base.pub[slug]?.root, priv: !!base.priv[slug]?.root }
    const stream = (set: 'public' | 'private') =>
      deltaChanges(internal, session.id, runs, slug, set, privateType, sets)
    return {
      slug,
      schema: s,
      schemaHash: hashes[slug]!,
      public: runs.length === 0 || privateType ? null : stream('public'),
      private: runs.length === 0 ? null : stream('private'),
    }
  })
}

/** Commit a delta session. Idempotent on the session status: only an open session commits. */
export async function commitDeltaSession(
  ports: Ports,
  session: SessionRow,
): Promise<
  CommitResult | { status: 'base_moved'; current: string | null } | { status: 'parallel' }
> {
  const base = await headBase(ports, session.collectionId)
  if ((base?.id ?? null) !== session.baseVersionId) {
    return { status: 'base_moved', current: base?.semver ?? null }
  }
  const inputs = await loadInputs(ports, session.id)
  const runs = await sessionRuns(ports, session.id)
  const repo = await ports.stores.forCollection(session.collectionId)
  const root = base ? await repo.root(base.hash) : null
  const priv = root?.private ? await repo.privateSet(root.private) : null
  const sets = { pub: root?.public ?? emptySet(), priv: priv ?? emptySet() }
  if (await planParallel(ports, session, { inputs, runs, base, repo, ...sets })) {
    return { status: 'parallel' }
  }
  const declared = 'all' in inputs.files ? null : inputs.files
  return commitVersion(ports, {
    collectionId: session.collectionId,
    base,
    types: await typeInputsForDelta(ports, session, inputs, runs, {
      pub: root?.public.types ?? {},
      priv: priv?.types ?? {},
    }),
    metadata: inputs.metadata,
    ...(declared ? { declaredFiles: declared } : {}),
    message: session.message,
    pushedBy: session.userId,
    appId: session.appId,
    actorId: session.actorId,
    validate: (s, data) => {
      const errs = compileSchema(s)(data)
      return errs.length > 0 ? errs : null
    },
  })
}

export { transition }
