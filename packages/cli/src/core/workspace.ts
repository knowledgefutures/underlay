/**
 * The workspace: a folder that can be committed and synced (local-tool.md "The workspace").
 *
 *   underlay.toml                       remotes, defaults, store rules
 *   AGENTS.md, CLAUDE.md                for agents working in the folder
 *   collections/<authority>/<org>/<name>/
 *     collection.toml                   id, authority, copies, what to keep, last pull and push
 *     README.md
 *     schemas/<Type>.json               edited here, saved with the next version
 *   scripts/   views/   inputs/
 *   .underlay/                          this machine's runs and locks (ignored by git)
 *
 * Records stay out of it: they live in the store.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { type Keep, TomlFile, WORKSPACE_HEADER, workspaceConfigPath } from './config.js'
import { CliError } from './env.js'

export interface CollectionRef {
  authority: string
  org: string
  name: string
}

export const keyOf = (c: CollectionRef) => `${c.authority}/${c.org}/${c.name}`

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?$/

/** `authority/org/name`, or `org/name` on the default remote. */
export function parseRef(text: string, defaultAuthority: string): CollectionRef {
  const parts = text
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .split('/')
  if (parts.length === 2) parts.unshift(defaultAuthority)
  if (parts.length !== 3) throw new CliError(`Name a collection as authority/org/name: ${text}`)
  const [authority, org, name] = parts as [string, string, string]
  if (!AUTHORITY.test(authority)) throw new CliError(`Not a server address: ${authority}`)
  if (!PART.test(org) || !PART.test(name)) throw new CliError(`Not an org/name: ${org}/${name}`)
  return { authority: authority.replace(/^www\./, ''), org, name }
}

export interface CollectionMeta extends CollectionRef {
  /** The collection's id, which its commits carry. */
  id: string
  /** Other servers that hold copies. */
  copies: string[]
  keep: Keep
  /** With keep = "some": the types kept. */
  types: string[]
  access: 'public' | 'private'
  /** Not yet on its authority: created there by its first push. */
  isNew: boolean
  title: string | null
  pulled: string | null
  pushed: string | null
}

export class Workspace {
  constructor(readonly root: string) {}

  /** The workspace holding `from`, or null. */
  static find(from = process.cwd()): Workspace | null {
    let dir = resolve(from)
    for (;;) {
      if (existsSync(workspaceConfigPath(dir))) return new Workspace(dir)
      const up = dirname(dir)
      if (up === dir) return null
      dir = up
    }
  }

  static init(dir: string): Workspace {
    const root = resolve(dir)
    mkdirSync(root, { recursive: true })
    const ws = new Workspace(root)
    if (!existsSync(workspaceConfigPath(root))) {
      const file = TomlFile.read(workspaceConfigPath(root), WORKSPACE_HEADER)
      file.data = { defaults: { remote: 'underlay.org' } }
      file.write()
    }
    for (const d of [
      'collections',
      'scripts',
      'scripts/imports',
      'views',
      'inputs',
      '.underlay/runs',
    ])
      mkdirSync(join(root, d), { recursive: true })
    writeIfAbsent(join(root, 'AGENTS.md'), AGENTS_MD)
    writeIfAbsent(join(root, 'CLAUDE.md'), 'Read AGENTS.md: it says how this folder works.\n')
    const gi = join(root, '.gitignore')
    const ignored = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
    if (!ignored.split('\n').includes('.underlay/'))
      writeFileSync(gi, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + '.underlay/\n')
    return ws
  }

  get stateDir() {
    return join(this.root, '.underlay')
  }

  collectionDir(c: CollectionRef) {
    return join(this.root, 'collections', c.authority, c.org, c.name)
  }

  /** Every collection on disk, sorted by authority, org, name. */
  collections(): CollectionMeta[] {
    const out: CollectionMeta[] = []
    const base = join(this.root, 'collections')
    for (const authority of dirs(base))
      for (const org of dirs(join(base, authority)))
        for (const name of dirs(join(base, authority, org))) {
          const m = this.readCollection({ authority, org, name })
          if (m) out.push(m)
        }
    return out
  }

  readCollection(c: CollectionRef): CollectionMeta | null {
    const path = join(this.collectionDir(c), 'collection.toml')
    if (!existsSync(path)) return null
    const t = TomlFile.read(path).data
    const keep = t.keep === 'all' || t.keep === 'some' ? t.keep : 'none'
    return {
      ...c,
      id: String(t.id ?? ''),
      copies: Array.isArray(t.copies) ? t.copies.map(String) : [],
      keep,
      types: Array.isArray(t.types) ? t.types.map(String) : [],
      access: t.access === 'public' ? 'public' : 'private',
      isNew: t.new === true,
      title: typeof t.title === 'string' ? t.title : null,
      pulled: typeof t.pulled === 'string' ? t.pulled : null,
      pushed: typeof t.pushed === 'string' ? t.pushed : null,
    }
  }

  /** The collection a ref names, which must be on disk. */
  collection(c: CollectionRef): CollectionMeta {
    const m = this.readCollection(c)
    if (!m)
      throw new CliError(`${keyOf(c)} is not in this workspace (underlay add, or underlay new)`)
    return m
  }

  /** A collection on disk by `authority/org/name`, `org/name`, or its name alone if that is unique. */
  resolve(text: string): CollectionMeta {
    const all = this.collections()
    const hits = all.filter(
      (c) => keyOf(c) === text || `${c.org}/${c.name}` === text || c.name === text,
    )
    if (hits.length === 1) return hits[0]!
    if (hits.length === 0) throw new CliError(`No collection ${text} in this workspace`)
    throw new CliError(`${text} could be ${hits.map(keyOf).join(' or ')}: say which`)
  }

  writeCollection(m: CollectionMeta): void {
    const dir = this.collectionDir(m)
    mkdirSync(join(dir, 'schemas'), { recursive: true })
    const file = TomlFile.read(
      join(dir, 'collection.toml'),
      `# ${keyOf(m)}: its authority numbers its versions (protocol-v3 4.6).\n`,
    )
    const t: Record<string, unknown> = {
      id: m.id,
      authority: m.authority,
      copies: m.copies,
      access: m.access,
      keep: m.keep,
    }
    if (m.keep === 'some') t.types = m.types
    if (m.title) t.title = m.title
    if (m.isNew) t.new = true
    if (m.pulled) t.pulled = m.pulled
    if (m.pushed) t.pushed = m.pushed
    file.data = t
    file.write()
  }

  /** The schemas in `schemas/`, by type. */
  schemas(c: CollectionRef): Record<string, unknown> {
    const dir = join(this.collectionDir(c), 'schemas')
    const out: Record<string, unknown> = {}
    if (!existsSync(dir)) return out
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue
      try {
        out[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch (err) {
        throw new CliError(`${relative(this.root, join(dir, f))}: ${(err as Error).message}`)
      }
    }
    return out
  }

  writeSchemas(c: CollectionRef, schemas: Record<string, unknown>): void {
    const dir = join(this.collectionDir(c), 'schemas')
    mkdirSync(dir, { recursive: true })
    for (const [type, body] of Object.entries(schemas))
      writeFileSync(join(dir, `${type}.json`), JSON.stringify(body, null, 2) + '\n')
  }

  rel(path: string) {
    return relative(this.root, path) || '.'
  }
}

function dirs(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter((n) => !n.startsWith('.') && statSync(join(path, n)).isDirectory())
    .sort()
}

function writeIfAbsent(path: string, text: string) {
  if (!existsSync(path)) writeFileSync(path, text)
}

export const AGENTS_MD = `# This folder is an Underlay workspace

It holds collections of records, the scripts that make new versions of them, and small
views. The \`underlay\` command (the Underlay CLI) works on it; run \`underlay --help\`.

## Layout

- \`underlay.toml\`: remotes and defaults, shared through git.
- \`collections/<authority>/<org>/<name>/\`: one folder per collection. \`collection.toml\` says
  which server numbers its versions (its authority) and how much of it is kept here;
  \`schemas/<Type>.json\` are its JSON Schemas, edited here and saved with the next version.
  Records are not in this folder: they live in the store (\`underlay status\` says where).
- \`scripts/\`: scripts that write collections. One script may write several.
- \`scripts/imports/*.toml\`: built-in importers with their options.
- \`views/<name>/index.html\`: small static pages, served by \`underlay serve\`.
- \`inputs/\`: files dropped in, and files views write.

## Scripts

A script is any executable (or a \`.ts\`, \`.js\`, \`.py\` or \`.sh\` file). Declare what it writes
in a header comment or a \`.toml\` beside it:

\`\`\`
// underlay: writes underlay.org/mitp/mit-ai
// underlay: reads underlay.org/mitp/units
// underlay: takes *.xlsx
\`\`\`

\`underlay run <script> [args]\` runs it with \`UNDERLAY_OUT\` set to a folder. For each collection
it writes, it writes NDJSON to \`$UNDERLAY_OUT/<authority>/<org>/<name>.ndjson\`: one record a
line, \`{"id": "...", "type": "...", "data": {...}}\`. Write the whole collection each time: the
tool compares it with the current version, saves a version with what changed, and records
missing from the output are removed. A script that writes nothing and exits non-zero on a
problem is a check. Read a collection with \`underlay export <collection>\` (NDJSON).

## Commands

- \`underlay status --json\`: collections here, versions not yet pushed, scripts, runs.
- \`underlay run <script> [args]\`, \`underlay log <collection>\`, \`underlay diff <collection>\`.
- \`underlay undo\`, \`underlay squash\`, \`underlay reword\`: change versions not yet pushed.
- \`underlay add-file <path>\`: copy a file into inputs/ and see what it matches.

## The rule

**Never push.** Saving versions is fine; \`underlay push\` is the person's step, and it asks
them to confirm. Leave versions saved and say what you did.
`
