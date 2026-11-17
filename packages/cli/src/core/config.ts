/**
 * Settings (local-tool.md "Configuration"): one file, yours,
 *
 *   ~/.config/underlay/config.toml   home, the store and its rules, remotes, script folders,
 *                                    handoff, serve
 *
 * Home and the store are personal, so nothing shared sets them. A script folder's own
 * `underlay.toml` says only what belongs to its code (sources.ts). The file is the source of
 * truth; `underlay config` and the settings screen edit it, keeping its header comment.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { parse, stringify } from 'smol-toml'

import { CliError, type Env, expandPath, tildePath } from './env.js'

export type Keep = 'all' | 'some' | 'none'

export interface StoreRule {
  /** `authority/org/name`, with `*` for any one part at the end (`underlay.org/mitp/*`). */
  match: string
  path?: string
  keep?: Keep
}

export interface RemoteConfig {
  /** The address: `underlay.org`, `staging.underlay.org`, `localhost:3000`. */
  name: string
  url: string
}

/** A script folder listed in config.toml. */
export interface SourceConfig {
  name: string
  path: string
}

export interface Settings {
  /** Home: collections, inputs, your own scripts. */
  home: string
  sources: SourceConfig[]
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

/** Remotes known without saying so. */
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
# Edit here, with \`underlay config set\`, or in the settings screen (,).
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
const personalFile = (env: Env) => TomlFile.read(personalPath(env), PERSONAL_HEADER)

const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }
export function parseSize(s: string): number {
  const m = /^\s*([\d.]+)\s*([KMGT]?B)\s*$/i.exec(s)
  if (!m) throw new CliError(`Not a size: ${JSON.stringify(s)} (say "200 GB")`)
  return Math.round(Number(m[1]) * UNITS[m[2]!.toUpperCase()]!)
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

export const DEFAULT_HOME = '~/Underlay'

/** The settings, from config.toml and the defaults. */
export function loadSettings(env: Env): Settings {
  const p = TomlFile.read(personalPath(env)).data
  const remotes = new Map(BUILT_IN_REMOTES.map((r) => [r.name, r]))
  for (const [name, r] of Object.entries((p.remotes ?? {}) as Record<string, Toml>))
    remotes.set(name, { name, url: str(r.url) ?? remotes.get(name)?.url ?? urlOf(name) })
  const limit = str(p.store?.limit)
  const rules = ((p.store?.rule ?? []) as Toml[]).flatMap((r): StoreRule[] => {
    if (typeof r.match !== 'string') return []
    const keep = str(r.keep)
    return [
      {
        match: r.match,
        ...(typeof r.path === 'string' ? { path: expandPath(env, r.path) } : {}),
        ...(keep === 'all' || keep === 'some' || keep === 'none' ? { keep } : {}),
      },
    ]
  })
  const sources = ((p.sources ?? []) as Toml[]).flatMap((s): SourceConfig[] =>
    typeof s.path === 'string'
      ? [
          {
            name: str(s.name) ?? basename(expandPath(env, s.path)),
            path: expandPath(env, s.path),
          },
        ]
      : [],
  )
  return {
    home: env.homeDir ?? expandPath(env, str(p.home) ?? DEFAULT_HOME),
    sources,
    storePath: str(p.store?.path) ? expandPath(env, p.store.path) : env.dataDir,
    storeLimit: limit ? parseSize(limit) : null,
    rules,
    remotes: [...remotes.values()],
    defaultRemote: str(p.defaults?.remote) ?? 'underlay.org',
    handoffSend: str(p.handoff?.send) ?? null,
    servePort: Number(p.serve?.port ?? 4417),
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
  group: 'Home' | 'Store' | 'Remotes' | 'Handoff' | 'Serve' | 'Terminal'
  /** The TOML path. */
  path: string[]
  default: string
  about: string
  /** The longer version, for the settings screen's About panel. */
  help?: string
  /** A setting with a few values: enter in the settings screen steps through them. */
  choices?: string[]
  parse?: (v: string) => unknown
}

export const SETTINGS: SettingDef[] = [
  {
    key: 'home',
    group: 'Home',
    path: ['home'],
    default: DEFAULT_HOME,
    about: 'Your collections, inputs and own scripts (UNDERLAY_HOME overrides it)',
    help: 'The folder holding your collections (each with its schemas), the inputs scripts read, and your own scripts. underlay init makes it. UNDERLAY_HOME in the environment wins over this.',
  },
  {
    key: 'defaults.remote',
    group: 'Remotes',
    path: ['defaults', 'remote'],
    default: 'underlay.org',
    about: 'The remote `underlay new`, `ls` and `login` use when none is named',
    help: 'The remote that underlay new and login use when you do not name one. Signing in to another while signed out of this one makes that one the default. A collection you add keeps its own authority whatever this says.',
  },
  {
    key: 'store.path',
    group: 'Store',
    path: ['store', 'path'],
    default: '~/.local/share/underlay',
    about: 'Where record files, unpushed versions and run logs live: outside Dropbox and iCloud',
    help: 'Where record files, versions not yet pushed, and run logs are kept. Keep it out of Dropbox and iCloud: they sync every file as it is written. Rules below can send some collections elsewhere.',
  },
  {
    key: 'store.limit',
    group: 'Store',
    path: ['store', 'limit'],
    default: '(none)',
    about: 'Fetched data past this is let go; unpushed versions never are',
    help: 'How much fetched data the store may hold, such as 20GB. Fetched data past it is let go; versions not yet pushed never are.',
    parse: (v) => (parseSize(v), v),
  },
  {
    key: 'handoff.send',
    group: 'Handoff',
    path: ['handoff', 'send'],
    default: '(copy only)',
    about: 'A command that takes a handoff prompt on stdin (C in the app)',
    help: 'A command that takes a handoff prompt on stdin, such as hopper draft new --project <key> -. In the terminal UI, C sends the prompt to it and c copies the prompt.',
  },
  {
    key: 'serve.port',
    group: 'Serve',
    path: ['serve', 'port'],
    default: '4417',
    about: 'The port `underlay serve` listens on',
    help: 'The port underlay serve listens on. A view that serves its own page is given a free port instead.',
    parse: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError('A port is 1 to 65535')
      return n
    },
  },
  {
    key: 'mascot',
    group: 'Terminal',
    path: ['mascot'],
    default: 'on',
    about: 'The woodpecker: on the help screen, when pushing and pulling, and after underlay init',
    help: 'The woodpecker from the Underlay logo, drawn in the terminal: on the help screen (?), beside the progress of a long push or pull, and after underlay init. It is never drawn when output goes to a file or another program, or when NO_COLOR is set.',
    choices: ['on', 'off'],
    parse: (v) => {
      if (v !== 'on' && v !== 'off') throw new CliError('mascot is on or off')
      return v
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

function dig(t: Toml, path: string[]): unknown {
  let at: any = t
  for (const p of path) at = at?.[p]
  return at
}

/** A setting's value, and whether it is set or the default. */
export function getSetting(env: Env, key: string): { value: string; from: 'set' | 'default' } {
  const def = settingDef(key)
  const v = dig(TomlFile.read(personalPath(env)).data, def.path)
  return v === undefined
    ? { value: def.default, from: 'default' }
    : { value: String(v), from: 'set' }
}

/** Set a setting; undefined removes it. The file's path. */
export function setSetting(env: Env, key: string, value: string | undefined): string {
  const def = settingDef(key)
  const file = personalFile(env)
  let at: Toml = file.data
  for (const p of def.path.slice(0, -1)) at = at[p] ??= {}
  const last = def.path.at(-1)!
  if (value === undefined) delete at[last]
  else at[last] = def.parse ? def.parse(value) : value
  file.write()
  return file.path
}

/** Add a store rule, or replace one with the same match. */
export function setRule(env: Env, rule: { match: string; path?: string; keep?: Keep }): string {
  const file = personalFile(env)
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

export function removeRule(env: Env, match: string): boolean {
  const file = personalFile(env)
  const list = (file.data.store?.rule ?? []) as Toml[]
  const kept = list.filter((r) => r.match !== match)
  if (kept.length === list.length) return false
  file.data.store.rule = kept
  file.write()
  return true
}

/** List a script folder in config.toml under a short name (the folder's own by default). */
export function addSource(env: Env, path: string, name?: string): SourceConfig {
  const abs = expandPath(env, path)
  if (!existsSync(abs)) throw new CliError(`No folder ${path}`)
  const short = name ?? basename(abs)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(short))
    throw new CliError(`Name it with letters, digits, ".", "_" or "-": ${short}`)
  if (short === 'home') throw new CliError('"home" is your home’s own scripts: name it --name …')
  const file = personalFile(env)
  const list = ((file.data.sources ??= []) as Toml[]).filter(
    (s) => s.name !== short && expandPath(env, String(s.path)) !== abs,
  )
  list.push({ name: short, path: tildePath(env, abs) })
  file.data.sources = list
  file.write()
  return { name: short, path: abs }
}

export function removeSource(env: Env, name: string): boolean {
  const file = personalFile(env)
  const list = (file.data.sources ?? []) as Toml[]
  const kept = list.filter((s) => s.name !== name)
  if (kept.length === list.length) return false
  file.data.sources = kept
  file.write()
  return true
}
