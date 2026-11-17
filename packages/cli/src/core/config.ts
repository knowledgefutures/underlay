/**
 * The two configuration files (local-tool.md "Configuration"):
 *
 *   ~/.config/underlay/config.toml   yours: workspaces, the store, sign-ins, handoff, serve
 *   <workspace>/underlay.toml        shared through git: remotes, defaults, store rules
 *
 * The workspace's file overrides the personal one where both set something, except paths,
 * which stay personal. The files are the source of truth; `underlay config` and the
 * settings screen edit them, keeping each file's header comment.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parse, stringify } from 'smol-toml'

import { CliError, type Env, expandPath } from './env.js'

export type Keep = 'all' | 'some' | 'none'

export interface StoreRule {
  /** `authority/org/name`, with `*` for any one part at the end (`underlay.org/mitp/*`). */
  match: string
  path?: string
  keep?: Keep
  /** Which file the rule is in. */
  from: 'personal' | 'workspace'
}

export interface RemoteConfig {
  /** The address: `underlay.org`, `staging.underlay.org`, `localhost:3000`. */
  name: string
  url: string
}

export interface Settings {
  workspaces: string[]
  defaultWorkspace: string | null
  storePath: string
  /** Bytes, or null for no limit. */
  storeLimit: number | null
  rules: StoreRule[]
  remotes: RemoteConfig[]
  defaultRemote: string
  handoffSend: string | null
  servePort: number
  /** Where keys are kept. */
  keys: string
}

/** Remotes every workspace knows without saying so. */
export const BUILT_IN_REMOTES: RemoteConfig[] = [
  { name: 'underlay.org', url: 'https://www.underlay.org' },
  { name: 'staging.underlay.org', url: 'https://staging.underlay.org' },
]

/** The URL of a remote named only by its address. */
export function urlOf(name: string): string {
  const local = /^(localhost|127\.|\[::1\])/.test(name)
  return `${local ? 'http' : 'https'}://${name}`
}

export const PERSONAL_HEADER = `# Underlay CLI: your settings (local-tool.md "Configuration").
# The workspace's underlay.toml overrides these where both set something, except paths.
# Edit here, with \`underlay config set\`, or in the settings screen (,).
`

export const WORKSPACE_HEADER = `# An Underlay workspace: collections, scripts and views (see AGENTS.md).
# Shared through git. Your own settings are in ~/.config/underlay/config.toml.
`

export type Toml = Record<string, any>

/** A TOML file and its leading comment block, which writes keep. */
export class TomlFile {
  constructor(
    readonly path: string,
    public data: Toml,
    public header: string,
  ) {}

  static read(path: string, header = ''): TomlFile {
    if (!existsSync(path)) return new TomlFile(path, {}, header)
    const text = readFileSync(path, 'utf8')
    let data: Toml
    try {
      data = parse(text) as Toml
    } catch (err) {
      throw new CliError(`${path}: ${(err as Error).message}`)
    }
    const lines = text.split('\n')
    const head: string[] = []
    for (const l of lines) {
      if (l.startsWith('#') || (l.trim() === '' && head.length > 0 && head.at(-1) !== ''))
        head.push(l)
      else break
    }
    while (head.length > 0 && head.at(-1)!.trim() === '') head.pop()
    return new TomlFile(path, data, head.length > 0 ? head.join('\n') + '\n' : header)
  }

  write(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const body = stringify(this.data)
    writeFileSync(
      this.path,
      (this.header ? this.header + '\n' : '') + body + (body.endsWith('\n') ? '' : '\n'),
    )
  }
}

export const personalPath = (env: Env) => join(env.configDir, 'config.toml')
export const workspaceConfigPath = (root: string) => join(root, 'underlay.toml')

const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }
export function parseSize(s: string): number {
  const m = /^\s*([\d.]+)\s*([KMGT]?B)\s*$/i.exec(s)
  if (!m) throw new CliError(`Not a size: ${JSON.stringify(s)} (say "200 GB")`)
  return Math.round(Number(m[1]) * UNITS[m[2]!.toUpperCase()]!)
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

function rulesOf(t: Toml, from: StoreRule['from'], env: Env): StoreRule[] {
  const list = (t.store?.rule ?? []) as Toml[]
  return list.flatMap((r) => {
    if (typeof r.match !== 'string') return []
    const keep = str(r.keep)
    const rule: StoreRule = { match: r.match, from }
    // Paths stay personal: a workspace's rule cannot send records somewhere on your disk.
    if (from === 'personal' && typeof r.path === 'string') rule.path = expandPath(env, r.path)
    if (keep === 'all' || keep === 'some' || keep === 'none') rule.keep = keep
    return [rule]
  })
}

/** Both files, merged. */
export function loadSettings(env: Env, workspaceRoot: string | null): Settings {
  const p = TomlFile.read(personalPath(env)).data
  const w = workspaceRoot ? TomlFile.read(workspaceConfigPath(workspaceRoot)).data : {}
  const remotes = new Map(BUILT_IN_REMOTES.map((r) => [r.name, r]))
  for (const t of [p, w]) {
    for (const [name, r] of Object.entries((t.remotes ?? {}) as Record<string, Toml>)) {
      remotes.set(name, { name, url: str(r.url) ?? remotes.get(name)?.url ?? urlOf(name) })
    }
  }
  const limit = str(w.store?.limit) ?? str(p.store?.limit)
  return {
    workspaces: ((p.workspace?.known ?? []) as string[]).map((x) => expandPath(env, x)),
    defaultWorkspace: str(p.workspace?.default) ? expandPath(env, p.workspace.default) : null,
    storePath: str(p.store?.path) ? expandPath(env, p.store.path) : env.dataDir,
    storeLimit: limit ? parseSize(limit) : null,
    // Workspace rules first: among equally specific matches, the shared one wins.
    rules: [...rulesOf(w, 'workspace', env), ...rulesOf(p, 'personal', env)],
    remotes: [...remotes.values()],
    defaultRemote: str(w.defaults?.remote) ?? str(p.defaults?.remote) ?? 'underlay.org',
    handoffSend: str(w.handoff?.send) ?? str(p.handoff?.send) ?? null,
    servePort: Number(w.serve?.port ?? p.serve?.port ?? 4417),
    keys: env.keys.kind,
  }
}

export function remoteOf(s: Settings, name: string): RemoteConfig {
  return s.remotes.find((r) => r.name === name) ?? { name, url: urlOf(name) }
}

/** How specific a rule's match is for a key, or -1 when it does not match. */
function matchScore(match: string, key: string): number {
  const m = match.split('/')
  const k = key.split('/')
  if (m.length > k.length) return -1
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '*') return i === m.length - 1 ? i : -1
    if (m[i] !== k[i]) return -1
  }
  return m.length === k.length ? 10 : m.length
}

/** The most specific rule for `authority/org/name`, if any: where its records go, and what to keep. */
export function ruleFor(s: Settings, key: string): { path: string; keep: Keep | null } {
  let path: { score: number; value: string } | null = null
  let keep: { score: number; value: Keep } | null = null
  for (const r of s.rules) {
    const score = matchScore(r.match, key)
    if (score < 0) continue
    if (r.path && (!path || score > path.score)) path = { score, value: r.path }
    if (r.keep && (!keep || score > keep.score)) keep = { score, value: r.keep }
  }
  return { path: path?.value ?? s.storePath, keep: keep?.value ?? null }
}

/** A setting the settings screen and `underlay config` know. */
export interface SettingDef {
  key: string
  group: 'Workspace' | 'Store' | 'Remotes' | 'Handoff' | 'Serve'
  /** Which file it goes in when set: personal for paths and sign-ins. */
  file: 'personal' | 'workspace'
  /** The TOML path. */
  path: string[]
  default: string
  about: string
  parse?: (v: string) => unknown
}

export const SETTINGS: SettingDef[] = [
  {
    key: 'workspace.default',
    group: 'Workspace',
    file: 'personal',
    path: ['workspace', 'default'],
    default: '(the folder you are in)',
    about: 'The workspace plain `underlay` opens when not run inside one',
  },
  {
    key: 'defaults.remote',
    group: 'Workspace',
    file: 'workspace',
    path: ['defaults', 'remote'],
    default: 'underlay.org',
    about: 'The remote `underlay new`, `ls` and `login` use when none is named',
  },
  {
    key: 'store.path',
    group: 'Store',
    file: 'personal',
    path: ['store', 'path'],
    default: '~/.local/share/underlay',
    about: 'Where record files, unpushed versions and run logs live: outside Dropbox and iCloud',
  },
  {
    key: 'store.limit',
    group: 'Store',
    file: 'personal',
    path: ['store', 'limit'],
    default: '(none)',
    about: 'Fetched data past this is let go; unpushed versions never are',
    parse: (v) => (parseSize(v), v),
  },
  {
    key: 'handoff.send',
    group: 'Handoff',
    file: 'workspace',
    path: ['handoff', 'send'],
    default: '(copy only)',
    about: 'A command that takes a handoff prompt on stdin (C in the app)',
  },
  {
    key: 'serve.port',
    group: 'Serve',
    file: 'personal',
    path: ['serve', 'port'],
    default: '4417',
    about: 'The port `underlay serve` listens on',
    parse: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError('A port is 1 to 65535')
      return n
    },
  },
]

/** A remote's URL is a setting too: `remotes.<name>.url`. */
export function settingDef(key: string): SettingDef {
  const def = SETTINGS.find((s) => s.key === key)
  if (def) return def
  const m = /^remotes\.(.+)\.url$/.exec(key)
  if (m)
    return {
      key,
      group: 'Remotes',
      file: 'workspace',
      path: ['remotes', m[1]!, 'url'],
      default: BUILT_IN_REMOTES.find((r) => r.name === m[1])?.url ?? urlOf(m[1]!),
      about: `Where ${m[1]} is served`,
      parse: (v) => {
        try {
          return new URL(v).origin
        } catch {
          throw new CliError(`Not a URL: ${v}`)
        }
      },
    }
  throw new CliError(
    `No setting ${key}. Settings: ${SETTINGS.map((s) => s.key).join(', ')}, remotes.<name>.url`,
  )
}

export function fileFor(env: Env, workspaceRoot: string | null, which: 'personal' | 'workspace') {
  if (which === 'workspace' && workspaceRoot)
    return TomlFile.read(workspaceConfigPath(workspaceRoot), WORKSPACE_HEADER)
  return TomlFile.read(personalPath(env), PERSONAL_HEADER)
}

function dig(t: Toml, path: string[]): unknown {
  let at: any = t
  for (const p of path) at = at?.[p]
  return at
}

/** A setting's value, and where it comes from. */
export function getSetting(
  env: Env,
  root: string | null,
  key: string,
): { value: string; from: 'workspace' | 'personal' | 'default' } {
  const def = settingDef(key)
  const w = root ? dig(TomlFile.read(workspaceConfigPath(root)).data, def.path) : undefined
  const p = dig(TomlFile.read(personalPath(env)).data, def.path)
  // Paths stay personal.
  if (w !== undefined && def.file === 'workspace') return { value: String(w), from: 'workspace' }
  if (p !== undefined) return { value: String(p), from: 'personal' }
  if (w !== undefined) return { value: String(w), from: 'workspace' }
  return { value: def.default, from: 'default' }
}

/** Set a setting in its file (or the one asked for); undefined removes it. */
export function setSetting(
  env: Env,
  root: string | null,
  key: string,
  value: string | undefined,
  where?: 'personal' | 'workspace',
): string {
  const def = settingDef(key)
  const file = fileFor(env, root, where ?? (root ? def.file : 'personal'))
  let at: Toml = file.data
  for (const p of def.path.slice(0, -1)) at = at[p] ??= {}
  const last = def.path.at(-1)!
  if (value === undefined) delete at[last]
  else at[last] = def.parse ? def.parse(value) : value
  file.write()
  return file.path
}

/** Add a store rule (personal when it has a path), or replace one with the same match. */
export function setRule(
  env: Env,
  root: string | null,
  rule: { match: string; path?: string; keep?: Keep },
): string {
  const file = fileFor(env, root, rule.path || !root ? 'personal' : 'workspace')
  const store = (file.data.store ??= {})
  const list = ((store.rule ??= []) as Toml[]).filter((r) => r.match !== rule.match)
  list.push({
    match: rule.match,
    ...(rule.path ? { path: rule.path } : {}),
    ...(rule.keep ? { keep: rule.keep } : {}),
  })
  store.rule = list
  file.write()
  return file.path
}

export function removeRule(env: Env, root: string | null, match: string): boolean {
  let removed = false
  for (const which of ['workspace', 'personal'] as const) {
    if (which === 'workspace' && !root) continue
    const file = fileFor(env, root, which)
    const list = (file.data.store?.rule ?? []) as Toml[]
    const kept = list.filter((r) => r.match !== match)
    if (kept.length !== list.length) {
      file.data.store.rule = kept
      file.write()
      removed = true
    }
  }
  return removed
}

/** Remember a workspace in the personal file; the first becomes the default. */
export function rememberWorkspace(env: Env, root: string): void {
  const file = fileFor(env, null, 'personal')
  const ws = (file.data.workspace ??= {})
  const known = new Set<string>(((ws.known ?? []) as string[]).map((x) => expandPath(env, x)))
  if (known.has(root) && ws.default) return
  known.add(root)
  ws.known = [...known]
  ws.default ??= root
  file.write()
}
