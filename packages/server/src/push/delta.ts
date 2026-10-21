/**
 * Delta push: the path at scale. A session names a base version and uploads
 * upserts (records) and deletes; the commit costs O(changes).
 *
 * Record lines go through the input rules, schema validation and canonical
 * hashing at upload, so commit never re-reads them. Large records are staged out
 * of line in the session's area right away, so runs stay small; the commit puts
 * them in the repository (changes.ts).
 */
import {
  checkRecordId,
  checkTypeSlug,
  compileSchema,
  emptySet,
  fileRefs,
  InputRuleError,
  OUT_OF_LINE_BYTES,
  parseRecordLine,
  parseStrict,
  recordCanonical,
  SchemaError,
  type SchemaValidator,
  sha256Hex,
  stripToSchema,
  utf8ByteLength,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { type BaseVersion, commitVersion, type TypeInput } from '../versions/commit.js'
import { deltaChanges, isPrivateSchema, stageOutOfLine } from './changes.js'
import type { SessionCommitResult } from './outcome.js'
import { keyOrderPlacer, OutOfKeyOrder, packEntries } from './packs.js'
import { planParallel, SerialTooLargeError } from './parallel.js'
import { type RunEntry, type RunIndex, writeRun } from './runs.js'
import {
  loadInputs,
  nextRunSeq,
  recordRun,
  schemaHashes,
  schemaSetError,
  type SessionInputs,
  sessionRuns,
  type SessionRow,
  transition,
} from './session.js'

/** 8 MB: an upload request holds its batch several times over (text, records, run lines). */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024
export const MAX_BATCH_LINES = 10_000
/**
 * A key-ordered session's batches (layout F, `in_key_order`): records stream into
 * packs as they arrive, so a request holds only its run entries (about 150 bytes a
 * record) and the pack filling. Larger batches mean fewer runs to compact.
 */
export const KEY_ORDER_BATCH_BYTES = 64 * 1024 * 1024
export const KEY_ORDER_BATCH_LINES = 50_000

/** A session's batch limits: larger for one whose records stream into packs. */
export const batchLimits = (session: Pick<SessionRow, 'inKeyOrder'>) =>
  session.inKeyOrder
    ? { bytes: KEY_ORDER_BATCH_BYTES, lines: KEY_ORDER_BATCH_LINES }
    : { bytes: MAX_BATCH_BYTES, lines: MAX_BATCH_LINES }
const MAX_REPORTED = 100

export interface LineError {
  line: number
  recordId?: string
  type?: string
  errors: string[]
}

export type IngestResult =
  | { ok: true; received: number }
  | {
      ok: false
      status: 400 | 409 | 413 | 422
      error: string
      details?: LineError[]
      total?: number
    }

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
  sessionId: string,
  inputs: SessionInputs,
  input: string | AsyncIterable<string>,
  /** `packed`: the records go into packs (layout F), so large ones aren't staged apart. */
  opts: {
    stripUnknownFields: boolean
    packed?: boolean
    maxLines?: number
    /** Each accepted record as it's read (a key-ordered session's packing), with its line number. */
    place?: (e: RunEntry, line: number) => Promise<void>
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
  const internal = ports.stores.internal
  const source = typeof input === 'string' ? lines(input) : input
  // Compiled once per type per batch. A schema that doesn't compile (a session
  // opened before the open-time check) fails its lines with a 422, not a 500.
  const validators = new Map<string, SchemaValidator | string>()
  const validatorFor = (type: string, s: Record<string, unknown>) => {
    let v = validators.get(type)
    if (v === undefined) {
      try {
        v = compileSchema(s)
      } catch (err) {
        if (!(err instanceof SchemaError)) throw err
        v = `The schema for type "${type}" is refused: ${err.message}`
      }
      validators.set(type, v)
    }
    return v
  }
  let i = -1
  for await (const line of source) {
    i++
    if (i >= (opts.maxLines ?? MAX_BATCH_LINES)) return { tooManyLines: true }
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
      const extra = Object.keys(data).filter((k) => !Object.hasOwn(props, k))
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
    const validate = validatorFor(rec.type, typeSchema)
    const errs = typeof validate === 'string' ? [validate] : validate(data)
    if (errs.length > 0) {
      fail({ line: i + 1, recordId: rec.id, type: rec.type, errors: errs })
      continue
    }
    const hash = sha256Hex(canonical)
    const size = utf8ByteLength(canonical)
    const body =
      size > OUT_OF_LINE_BYTES && !opts.packed
        ? await stageOutOfLine(internal, sessionId, hash, canonical)
        : canonical
    const isPrivate = isPrivateSchema(typeSchema) || rec.private === true
    // A packed record's body leaves its entry (push/packs.ts): the commit counts its
    // file references from these.
    const refs = opts.packed && canonical.includes('"$file"') ? fileRefs(data) : []
    const entry: RunEntry = {
      t: rec.type,
      k: rec.id,
      h: hash,
      s: size,
      b: body,
      ...(isPrivate ? { p: true } : {}),
      ...(refs.length ? { r: refs } : {}),
    }
    // A batch with an invalid record is refused whole: nothing more is packed.
    if (opts.place && total === 0) await opts.place(entry, i + 1)
    entries.push(entry)
  }
  return total > 0 ? { errors, total } : { entries }
}

export async function ingestRecords(
  ports: Ports,
  session: SessionRow,
  input: string | AsyncIterable<string>,
): Promise<IngestResult> {
  const inputs = await loadInputs(ports, session.id)
  // Layout F: the records go straight into the collection's packs; a key-ordered
  // session's as they arrive.
  const records = (await ports.stores.forCollection(session.collectionId)).records
  const placer = records && session.inKeyOrder ? keyOrderPlacer(ports, session.id, records) : null
  const limits = batchLimits(session)
  let prepared
  try {
    prepared = await prepareRecords(ports, session.id, inputs, input, {
      stripUnknownFields: session.stripUnknownFields,
      packed: records !== null,
      maxLines: limits.lines,
      ...(placer ? { place: placer.place } : {}),
    })
  } catch (err) {
    // Packs already written are reported (their rows' stats), so cleanup settles them.
    await placer?.finish().catch(() => {})
    if (err instanceof OutOfKeyOrder) return { ok: false, status: 422, error: err.message }
    throw err
  }
  await placer?.finish()
  if ('tooManyLines' in prepared) {
    return { ok: false, status: 413, error: `At most ${limits.lines} records per batch` }
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
  if (records && !placer) await packEntries(ports, session.id, records, prepared.entries)
  const index = await writeRun(ports.stores.internal, session.id, seq, prepared.entries)
  await recordRun(ports, session.id, 'records', index, { records: prepared.entries.length })
  return { ok: true, received: prepared.entries.length }
}

/** One delete line, `{"type", "id"}`, under the input rules. Throws InputRuleError. */
function parseDeleteLine(line: string): { type: string; id: string } {
  const v = parseStrict(line)
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new InputRuleError('bad_envelope', 'Each line is {"type": …, "id": …}')
  const { type, id } = v as { type?: unknown; id?: unknown }
  const idError = checkRecordId(id)
  if (idError) throw new InputRuleError('bad_id', idError)
  const typeError = checkTypeSlug(type)
  if (typeError) throw new InputRuleError('bad_type', typeError)
  return { type: type as string, id: id as string }
}

export async function ingestDeletes(
  ports: Ports,
  session: SessionRow,
  text: string,
): Promise<IngestResult> {
  const inputs = await loadInputs(ports, session.id)
  const entries: RunEntry[] = []
  const errors: LineError[] = []
  let total = 0
  const fail = (e: LineError) => {
    total++
    if (errors.length < MAX_REPORTED) errors.push(e)
  }
  const all = lines(text)
  if (all.length > MAX_BATCH_LINES)
    return { ok: false, status: 413, error: `At most ${MAX_BATCH_LINES} deletes per batch` }
  all.forEach((l, i) => {
    let d
    try {
      d = parseDeleteLine(l)
    } catch (err) {
      if (!(err instanceof InputRuleError)) throw err
      fail({ line: i + 1, errors: [`${err.code}: ${err.message}`] })
      return
    }
    if (!inputs.schemas[d.type]) {
      fail({
        line: i + 1,
        recordId: d.id,
        type: d.type,
        errors: [`No schema for type "${d.type}"`],
      })
    } else {
      entries.push({ t: d.type, k: d.id, x: true })
    }
  })
  if (total > 0) return { ok: false, status: 422, error: 'Invalid deletes', details: errors, total }
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
  const repo = await ports.stores.forCollection(session.collectionId)
  const hashes = schemaHashes(inputs.schemas)
  return Object.entries(inputs.schemas).map(([slug, s]) => {
    const privateType = isPrivateSchema(s)
    const sets = { pub: !!base.pub[slug]?.root, priv: !!base.priv[slug]?.root }
    const stream = (set: 'public' | 'private') =>
      deltaChanges(internal, repo, session.id, runs, slug, set, privateType, sets)
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
  fence: number,
): Promise<SessionCommitResult> {
  const base = await headBase(ports, session.collectionId)
  if ((base?.id ?? null) !== session.baseVersionId) {
    return { status: 'base_moved', current: base?.semver ?? null }
  }
  const inputs = await loadInputs(ports, session.id)
  // Sessions opened before the open-time check may hold a schema that doesn't
  // compile; none is ever published.
  const schemaErr = schemaSetError(inputs.schemas)
  if (schemaErr) return { status: 'schema_refused', error: schemaErr }
  const runs = await sessionRuns(ports, session.id)
  const repo = await ports.stores.forCollection(session.collectionId)
  const root = base ? await repo.root(base.hash) : null
  const priv = root?.private ? await repo.privateSet(root.private) : null
  const sets = { pub: root?.public ?? emptySet(), priv: priv ?? emptySet() }
  try {
    if (await planParallel(ports, session, { inputs, runs, base, repo, fence, ...sets })) {
      return { status: 'parallel' }
    }
  } catch (err) {
    if (err instanceof SerialTooLargeError) return { status: 'schema_refused', error: err.message }
    throw err
  }
  return commitVersion(ports, {
    collectionId: session.collectionId,
    fence,
    base,
    types: await typeInputsForDelta(ports, session, inputs, runs, {
      pub: root?.public.types ?? {},
      priv: priv?.types ?? {},
    }),
    metadata: inputs.metadata,
    declaredFiles: inputs.files,
    message: session.message,
    pushedBy: session.userId,
    appId: session.appId,
    actorId: session.actorId,
    pushSessionId: session.id,
    validate: (s, data) => {
      const errs = compileSchema(s)(data)
      return errs.length > 0 ? errs : null
    },
  })
}

export { transition }
