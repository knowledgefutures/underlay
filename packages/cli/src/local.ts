/**
 * The local repository: `.underlay/` in a working directory.
 *
 *   repo/                  a repository in the protocol layout (fileStore): nodes,
 *                          bodies, roots, schemas, private set objects, files
 *   HEAD                   the current local version's semver (empty before the first)
 *   versions/<semver>.json local versions (LocalVersion)
 *   salt                   the private-set salt (the registry's, once pulled)
 *   staging/schemas.json   staged type schemas (the full new type set)
 *   staging/metadata.json  staged metadata
 *   staging/ops.ndjson     staged upserts and deletes, in order (the last per record wins)
 *   config.json            remotes
 *   remotes/<name>.json    what was last pulled from or pushed to a remote (Tracking)
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  compareSemver,
  fileStore,
  newSalt,
  openRepo,
  type PublicKeyInfo,
  type Repo,
} from '@underlay/protocol'

export const DIR = '.underlay'

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

export interface LocalVersion {
  semver: string
  hash: string
  baseSemver: string | null
  message: string | null
  createdAt: string
  /**
   * The file reference count trees (writer bookkeeping, not in the version
   * itself). Null when unknown, as for a pulled version; rebuilt on demand.
   */
  refs: { public: string | null; private: string | null } | null
  /** Set when this version came from, or was confirmed by, a remote. */
  remote?: string
  /** The sets this repository holds of the version. */
  sets: 'public' | 'all'
}

export interface RemoteConfig {
  url: string
  /** owner/slug */
  collection: string
  token?: string
}

export interface Tracking {
  seq: number
  entryHash: string
  semver: string
  hash: string
  sets: 'public' | 'all'
  /** The keys the remote's log was verified with. */
  keys: PublicKeyInfo[]
}

/** One staged operation: an upsert (canonical record) or a delete. */
export type StagedOp =
  | { op: 'put'; type: string; id: string; canonical: string; private?: true }
  | { op: 'del'; type: string; id: string }

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

export class Local {
  readonly dir: string
  #repo: Repo | undefined

  constructor(readonly root: string) {
    this.dir = join(root, DIR)
  }

  /** The repository containing `start`, or null. */
  static find(start = process.cwd()): Local | null {
    let dir = resolve(start)
    for (;;) {
      if (existsSync(join(dir, DIR))) return new Local(dir)
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  static require(start = process.cwd()): Local {
    const local = Local.find(start)
    if (!local) throw new CliError('Not an Underlay repository. Run `underlay init` first.')
    return local
  }

  static init(dir: string): Local {
    const local = new Local(resolve(dir))
    if (existsSync(local.dir)) throw new CliError(`${local.dir} already exists`)
    mkdirSync(join(local.dir, 'repo'), { recursive: true })
    mkdirSync(join(local.dir, 'versions'), { recursive: true })
    mkdirSync(join(local.dir, 'staging'), { recursive: true })
    writeFileSync(join(local.dir, 'HEAD'), '')
    writeFileSync(join(local.dir, 'salt'), newSalt())
    writeJson(join(local.dir, 'config.json'), { remotes: {} })
    return local
  }

  /** The local objects. Trusted: everything in it was verified on the way in. */
  get repo(): Repo {
    return (this.#repo ??= openRepo(fileStore(join(this.dir, 'repo')), { trusted: true }))
  }

  // --- Versions ---

  head(): string | null {
    const s = readFileSync(join(this.dir, 'HEAD'), 'utf8').trim()
    return s || null
  }

  setHead(semver: string): void {
    writeFileSync(join(this.dir, 'HEAD'), semver)
  }

  headVersion(): LocalVersion | null {
    const h = this.head()
    return h ? this.version(h) : null
  }

  version(semver: string): LocalVersion | null {
    return readJson<LocalVersion>(join(this.dir, 'versions', `${semver}.json`))
  }

  writeVersion(v: LocalVersion): void {
    writeJson(join(this.dir, 'versions', `${v.semver}.json`), v)
  }

  versions(): LocalVersion[] {
    const dir = join(this.dir, 'versions')
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<LocalVersion>(join(dir, f))!)
      .sort((a, b) => compareSemver(a.semver, b.semver))
  }

  salt(): string {
    return readFileSync(join(this.dir, 'salt'), 'utf8').trim()
  }

  setSalt(salt: string): void {
    writeFileSync(join(this.dir, 'salt'), salt)
  }

  // --- Staging ---

  stagedSchemas(): Record<string, Record<string, unknown>> | null {
    return readJson(join(this.dir, 'staging', 'schemas.json'))
  }

  stageSchemas(schemas: Record<string, Record<string, unknown>>): void {
    writeJson(join(this.dir, 'staging', 'schemas.json'), schemas)
  }

  /** Staged metadata: `undefined` when none is staged (null is a staged clear). */
  stagedMetadata(): Record<string, unknown> | null | undefined {
    const v = readJson<{ metadata: Record<string, unknown> | null }>(
      join(this.dir, 'staging', 'metadata.json'),
    )
    return v ? v.metadata : undefined
  }

  stageMetadata(metadata: Record<string, unknown> | null): void {
    writeJson(join(this.dir, 'staging', 'metadata.json'), { metadata })
  }

  stagedOps(): StagedOp[] {
    const path = join(this.dir, 'staging', 'ops.ndjson')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as StagedOp)
  }

  stageOps(ops: StagedOp[]): void {
    if (ops.length === 0) return
    mkdirSync(join(this.dir, 'staging'), { recursive: true })
    appendFileSync(
      join(this.dir, 'staging', 'ops.ndjson'),
      ops.map((o) => JSON.stringify(o)).join('\n') + '\n',
    )
  }

  clearStaging(): void {
    rmSync(join(this.dir, 'staging'), { recursive: true, force: true })
    mkdirSync(join(this.dir, 'staging'), { recursive: true })
  }

  // --- Remotes ---

  remotes(): Record<string, RemoteConfig> {
    return readJson<{ remotes: Record<string, RemoteConfig> }>(join(this.dir, 'config.json'))!
      .remotes
  }

  setRemotes(remotes: Record<string, RemoteConfig>): void {
    writeJson(join(this.dir, 'config.json'), { remotes })
  }

  remote(name: string): RemoteConfig {
    const r = this.remotes()[name]
    if (!r) throw new CliError(`No remote named "${name}". Add one with \`underlay remote add\`.`)
    return r
  }

  tracking(name: string): Tracking | null {
    return readJson<Tracking>(join(this.dir, 'remotes', `${name}.json`))
  }

  setTracking(name: string, t: Tracking | null): void {
    const path = join(this.dir, 'remotes', `${name}.json`)
    if (t) writeJson(path, t)
    else rmSync(path, { force: true })
  }
}
