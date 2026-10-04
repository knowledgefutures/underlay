/**
 * `underlay commit`: staged changes become a local version, built by the same
 * engine the registry commits with (`buildVersion`), so the registry builds the
 * same trees when the version is pushed.
 */
import {
  applyFileSet,
  buildVersion,
  type BuildTypeInput,
  type Change,
  compareUtf8,
  compileSchema,
  deriveSemver,
  emptySet,
  fileRefs,
  fileTree,
  hashSchema,
  isPrivateSchema,
  iterate,
  keys,
  MissingFilesError,
  OUT_OF_LINE_BYTES,
  type RecordEntry,
  recordTree,
  RepoSource,
  type SetObject,
  sha256Hex,
  utf8ByteLength,
} from '@underlay/protocol'

import { CliError, type Local, type LocalVersion, type StagedOp } from '../local.js'
import { versionState, type VersionState } from '../state.js'
import type { Say } from './stage.js'

/**
 * Sizes of files entering a set: from the local file store (`underlay file
 * add`), else from the file trees of the versions this repository already has.
 */
function fileSizer(local: Local, known: SetObject[]) {
  return async (hashes: string[]) => {
    const out = new Map<string, number>()
    for (const h of hashes) {
      const head = await local.repo.blobs.head(keys.file(h))
      if (head) out.set(h, head.size)
    }
    const missing = new Set(hashes.filter((h) => !out.has(h)))
    for (const set of known) {
      if (missing.size === 0) break
      for await (const e of iterate(new RepoSource(fileTree, local.repo), set.files.root)) {
        if (missing.delete(e.key)) out.set(e.key, e.size)
      }
    }
    return out
  }
}

/**
 * The file reference count trees of a version. A pulled version doesn't carry
 * them (they're writer bookkeeping), so they're rebuilt once from its records:
 * every reference counts, and a private-set file no record references was
 * declared.
 */
export async function ensureRefs(
  local: Local,
  state: VersionState,
): Promise<{ public: string | null; private: string | null }> {
  if (state.version.refs) return state.version.refs
  const repo = local.repo
  const out = { public: null as string | null, private: null as string | null }
  for (const name of ['public', 'private'] as const) {
    const set = state[name]
    const counts = new Map<string, number>()
    for (const t of Object.values(set.types)) {
      for await (const e of iterate(new RepoSource(recordTree, repo), t.root, { payloads: true })) {
        if (!e.body!.includes('"$file"')) continue
        for (const h of fileRefs((JSON.parse(e.body!) as { data: unknown }).data)) {
          counts.set(h, (counts.get(h) ?? 0) + 1)
        }
      }
    }
    const inSet: string[] = []
    const sizes = new Map<string, number>()
    for await (const e of iterate(new RepoSource(fileTree, repo), set.files.root)) {
      inSet.push(e.key)
      sizes.set(e.key, e.size)
    }
    const declared = name === 'private' ? inSet.filter((h) => !counts.has(h)) : []
    const result = await applyFileSet(
      repo,
      { refsRoot: null, files: emptySet().files },
      counts,
      declared.length > 0 ? { add: declared, remove: [] } : null,
      async (hs) => new Map(hs.filter((h) => sizes.has(h)).map((h) => [h, sizes.get(h)!])),
    )
    if (result.files.root !== set.files.root) {
      throw new CliError(
        `The ${name} file set of ${state.version.semver} doesn't match its records`,
      )
    }
    out[name] = result.refsRoot
  }
  local.writeVersion({ ...state.version, refs: out })
  return out
}

/** The staged operations, last one per (type, id) winning, sorted per type. */
function opsByType(ops: StagedOp[]): Map<string, StagedOp[]> {
  const last = new Map<string, StagedOp>()
  for (const op of ops) last.set(`${op.type}\u0000${op.id}`, op)
  const byType = new Map<string, StagedOp[]>()
  for (const op of last.values()) byType.set(op.type, [...(byType.get(op.type) ?? []), op])
  for (const list of byType.values()) list.sort((a, b) => compareUtf8(a.id, b.id))
  return byType
}

export async function commit(local: Local, message: string, say: Say): Promise<LocalVersion> {
  const head = local.headVersion()
  const base = head ? await versionState(local, head) : null
  const stagedSchemas = local.stagedSchemas()
  const stagedMetadata = local.stagedMetadata()
  const ops = local.stagedOps()
  if (!stagedSchemas && stagedMetadata === undefined && ops.length === 0) {
    throw new CliError('Nothing staged.')
  }
  const schemas = stagedSchemas ?? base?.schemas ?? {}
  if (Object.keys(schemas).length === 0)
    throw new CliError('No schemas. Run `underlay schema-set`.')
  const metadata = stagedMetadata !== undefined ? stagedMetadata : (base?.root.metadata ?? null)
  const repo = local.repo
  const byType = opsByType(ops)
  for (const type of byType.keys()) {
    if (!schemas[type]) throw new CliError(`Staged records of type "${type}", which has no schema`)
  }

  const types: BuildTypeInput[] = []
  for (const [slug, schema] of Object.entries(schemas)) {
    const privateType = isPrivateSchema(schema)
    const inPub = !!base?.public.types[slug]?.root
    const inPriv = !!base?.private.types[slug]?.root
    const validate = compileSchema(schema)
    const typeOps = byType.get(slug) ?? []
    // Revalidate staged records against the schema they will be committed under.
    for (const op of typeOps) {
      if (op.op !== 'put') continue
      const errs = validate((JSON.parse(op.canonical) as { data: unknown }).data)
      if (errs.length > 0) throw new CliError(`${slug} ${op.id}: ${errs.join('; ')}`)
    }
    const entries = new Map<StagedOp, RecordEntry>()
    for (const op of typeOps) {
      if (op.op !== 'put') continue
      const hash = sha256Hex(op.canonical)
      const size = utf8ByteLength(op.canonical)
      const body =
        size > OUT_OF_LINE_BYTES ? await repo.putOutOfLine(hash, op.canonical) : op.canonical
      entries.set(op, { key: op.id, hash, size, body })
    }
    // As the registry splits a delta push: an upsert goes to its set and is a
    // delete in the other; a delete goes to both.
    const stream = (set: 'public' | 'private'): Change<RecordEntry>[] => {
      const inBase = set === 'public' ? inPub : inPriv
      const out: Change<RecordEntry>[] = []
      for (const op of typeOps) {
        if (op.op === 'del') {
          if (inBase) out.push({ key: op.id, entry: null })
          continue
        }
        const target = privateType || op.private ? 'private' : 'public'
        if (target === set) out.push({ key: op.id, entry: { ...entries.get(op)! } })
        else if (inBase) out.push({ key: op.id, entry: null })
      }
      return out
    }
    types.push({
      slug,
      schema,
      schemaHash: hashSchema(schema),
      public: privateType ? null : stream('public'),
      private: stream('private'),
    })
  }

  const refs = base ? await ensureRefs(local, base) : null
  const known = base ? [base.public, base.private] : []
  let built
  try {
    built = await buildVersion(repo, {
      base: base
        ? { hash: base.version.hash, publicRefsRoot: refs!.public, privateRefsRoot: refs!.private }
        : null,
      types,
      metadata,
      salt: local.salt(),
      fileSizes: fileSizer(local, known),
      validate: (schema, data) => {
        const errs = compileSchema(schema)(data)
        return errs.length > 0 ? errs : null
      },
    })
  } catch (err) {
    if (err instanceof MissingFilesError) {
      throw new CliError(
        `Records reference files this repository doesn't have; add them with \`underlay file add\`:\n  ${err.hashes.join('\n  ')}`,
      )
    }
    throw err
  }
  if (built.status === 'invalid') {
    throw new CliError(
      `The new schemas reject ${built.total} existing record(s):\n  ${built.errors
        .slice(0, 20)
        .map((e) => `${e.type} ${e.recordId}: ${e.errors.join('; ')}`)
        .join('\n  ')}`,
    )
  }
  if (base && built.versionHash === base.version.hash) {
    local.clearStaging()
    throw new CliError('No changes: the staged changes leave the version as it is.')
  }
  const sv = deriveSemver(head?.semver ?? null, built.schemaChanged, built.recordsChanged)
  if (local.version(sv.semver)) {
    throw new CliError(`Version ${sv.semver} already exists here`)
  }
  const version: LocalVersion = {
    semver: sv.semver,
    hash: built.versionHash,
    baseSemver: head?.semver ?? null,
    message,
    createdAt: new Date().toISOString(),
    refs: { public: built.publicRefsRoot, private: built.privateRefsRoot },
    sets: 'all',
  }
  local.writeVersion(version)
  local.setHead(version.semver)
  local.clearStaging()
  const { added, removed, updated } = built.stats
  say(`${sv.semver} ${built.versionHash.slice(0, 17)}… ${message}`)
  say(`  +${added} ~${updated} -${removed} record(s)`)
  return version
}
