/**
 * Built-in importers and dropped files (local-tool.md "Dropping a file"; phase 3).
 *
 * One reader a format, each giving a file's sheets or tables as rows of plain objects:
 * CSV and TSV, Excel, JSON and NDJSON, Parquet, and SQLite (`node:sqlite`). An import maps
 * one sheet or table to one type in one collection, with options kept in a `.toml` (saved in
 * home's `scripts/imports/<name>.toml`, and movable to a script folder); running it writes the collection's NDJSON, and the run
 * saves a version like any other. `eject` turns it into an editable script.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'

import { v3 } from '@underlay/protocol'

import { TomlFile } from './config.js'
import { type Ctx, openColl } from './context.js'
import { CliError } from './env.js'
import { keyOf, parseRef } from './home.js'
import { fileArg } from './runs.js'
import { listScripts, type ScriptInfo, takesFile } from './scripts.js'
import { PAST_RESERVED, viewOf } from './versions.js'

export type Format = 'csv' | 'tsv' | 'xlsx' | 'json' | 'ndjson' | 'parquet' | 'sqlite'
export type Row = Record<string, unknown>

export interface Table {
  name: string
  columns: string[]
  rows: Row[]
}

const FORMATS: Record<string, Format> = {
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.tab': 'tsv',
  '.xlsx': 'xlsx',
  '.json': 'json',
  '.ndjson': 'ndjson',
  '.jsonl': 'ndjson',
  '.parquet': 'parquet',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
  '.db': 'sqlite',
}

export function formatOf(path: string): Format {
  const f = FORMATS[extname(path).toLowerCase()]
  if (!f)
    throw new CliError(
      `No built-in importer for ${extname(path) || 'this file'} (${Object.keys(FORMATS).join(' ')})`,
    )
  return f
}

const columnsOf = (rows: Row[]) => {
  const seen = new Set<string>()
  for (const r of rows.slice(0, 1000)) for (const k of Object.keys(r)) seen.add(k)
  return [...seen]
}

/** Every sheet or table of a file, read whole. `query` reads a SQLite query as one table. */
export async function readTables(path: string, opts: { query?: string } = {}): Promise<Table[]> {
  const format = formatOf(path)
  if (format === 'csv' || format === 'tsv') {
    const { parse } = await import('csv-parse/sync')
    const rows = parse(readFileSync(path), {
      columns: true,
      delimiter: format === 'tsv' ? '\t' : ',',
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Row[]
    return [{ name: basename(path), columns: columnsOf(rows), rows }]
  }
  if (format === 'xlsx') {
    const { default: readXlsxFile, readSheetNames } = await import('read-excel-file/node')
    const out: Table[] = []
    for (const sheet of await readSheetNames(path)) {
      const grid = (await readXlsxFile(path, { sheet })) as unknown[][]
      const header = (grid[0] ?? []).map((h, i) =>
        h === null || h === undefined || h === '' ? `column ${i + 1}` : String(h),
      )
      const rows = grid
        .slice(1)
        .filter((r) => r.some((v) => v !== null && v !== ''))
        .map((r) => {
          const o: Row = {}
          header.forEach((h, i) => {
            const v = r[i]
            if (v !== null && v !== undefined && v !== '')
              o[h] = v instanceof Date ? v.toISOString().slice(0, 10) : v
          })
          return o
        })
      out.push({ name: sheet, columns: header, rows })
    }
    return out
  }
  if (format === 'json') {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (Array.isArray(data))
      return [{ name: basename(path), columns: columnsOf(data as Row[]), rows: data as Row[] }]
    if (data && typeof data === 'object') {
      const tables = Object.entries(data as Record<string, unknown>)
        .filter(([, v]) => Array.isArray(v) && v.every((x) => x && typeof x === 'object'))
        .map(([k, v]) => ({ name: k, columns: columnsOf(v as Row[]), rows: v as Row[] }))
      if (tables.length > 0) return tables
    }
    throw new CliError(`${basename(path)}: no array of objects in it`)
  }
  if (format === 'ndjson') {
    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Row)
    return [{ name: basename(path), columns: columnsOf(rows), rows }]
  }
  if (format === 'parquet') {
    const { asyncBufferFromFile, parquetReadObjects } = await import('hyparquet')
    const file = await asyncBufferFromFile(path)
    const rows = (await parquetReadObjects({ file })) as Row[]
    for (const r of rows)
      for (const [k, v] of Object.entries(r)) if (typeof v === 'bigint') r[k] = Number(v)
    return [{ name: basename(path), columns: columnsOf(rows), rows }]
  }
  // SQLite: built into Node, no native module of ours.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    if (opts.query) {
      const rows = db.prepare(opts.query).all() as Row[]
      return [{ name: 'query', columns: columnsOf(rows), rows }]
    }
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
    return names.map(({ name }) => {
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Row[]
      const columns = (
        db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all() as { name: string }[]
      ).map((c) => c.name)
      return { name, columns, rows }
    })
  } finally {
    db.close()
  }
}

export async function readTable(
  path: string,
  opts: { sheet?: string; query?: string } = {},
): Promise<Table> {
  const tables = await readTables(path, opts)
  if (opts.sheet) {
    const t = tables.find((x) => x.name === opts.sheet)
    if (!t)
      throw new CliError(
        `${basename(path)} has no sheet or table ${opts.sheet} (${tables.map((x) => x.name).join(', ')})`,
      )
    return t
  }
  if (tables.length > 1)
    throw new CliError(
      `${basename(path)} has ${tables.length} sheets or tables: say which (${tables.map((x) => x.name).join(', ')})`,
    )
  return tables[0]!
}

/** Columns that look personal: left out of an import unless asked for. */
export const PERSONAL =
  /e-?mail|phone|mobile|\btel\b|address|ssn|social.?security|birth|\bdob\b|passport/i

const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

const ID_NAME = /(^|[^a-z])(id|ids|identifier|key|code|orcid|doi|ror)$|^id[^a-z]/i

/**
 * Columns whose values are unique where present: likely ids. A column named like one
 * (`person_id`, `ID`, `doi`) counts when at least half the rows have it, since rows without
 * an id are held; another only when nearly every row does. Those named like ids come first.
 */
export function idColumns(t: Table): string[] {
  const out = t.columns.filter((c) => {
    const vals = t.rows.map((r) => r[c]).filter((v) => !isEmpty(v))
    const named = ID_NAME.test(c)
    if (vals.length < Math.max(1, t.rows.length * (named ? 0.5 : 0.95))) return false
    return new Set(vals.map(String)).size === vals.length
  })
  return out.sort((a, b) => Number(ID_NAME.test(b)) - Number(ID_NAME.test(a)))
}

export interface Match {
  collection: string
  type: string
  column: string
  /** Values of the column that are ids of that type, of how many. */
  hits: number
  of: number
}

/** The collections here whose ids a table's id columns match, best first. */
export async function matchTable(ctx: Ctx, t: Table): Promise<Match[]> {
  const cols = idColumns(t)
  if (cols.length === 0) return []
  const out: Match[] = []
  for (const meta of ctx.home.collections()) {
    // Matched against what is here: a collection kept as metadata only is not fetched.
    if (meta.keep === 'none') continue
    const c = openColl(ctx, meta)
    if ((await v3.headNumber(c.store.fs, meta.id)) === 0) continue
    const ids = new Map<string, Set<string>>()
    for await (const g of v3.mergeGroups(c.store.fs, await viewOf(c), { from: PAST_RESERVED })) {
      const e = g[g.length - 1]!.entry
      if (e.kind === 'x') continue
      let s = ids.get(e.type)
      if (!s) ids.set(e.type, (s = new Set()))
      s.add(e.id)
    }
    for (const col of cols) {
      const vals = t.rows
        .map((r) => r[col])
        .filter((v) => !isEmpty(v))
        .map(String)
      for (const [type, set] of ids) {
        const hits = vals.filter((v) => set.has(v)).length
        if (hits > 0)
          out.push({ collection: keyOf(meta), type, column: col, hits, of: vals.length })
      }
    }
  }
  return out.sort((a, b) => b.hits / b.of - a.hits / a.of || b.hits - a.hits)
}

export interface Shape {
  path: string
  format: Format
  tables: {
    name: string
    columns: string[]
    rows: number
    idColumns: string[]
    personal: string[]
    sample: Row[]
  }[]
  matches: (Match & { table: string })[]
  /** Scripts and imports that take a file like this. */
  scripts: ScriptInfo[]
}

/** Copy a file into home's `inputs/` (unless it is in home already) and read its shape. */
export async function addFile(ctx: Ctx, path: string): Promise<Shape> {
  const abs = fileArg(ctx, path)
  if (!abs) throw new CliError(`No file ${path}`)
  let at = abs
  if (relative(ctx.home.root, abs).startsWith('..')) {
    mkdirSync(ctx.home.inputsDir, { recursive: true })
    at = join(ctx.home.inputsDir, basename(abs))
    copyFileSync(abs, at)
  }
  return shapeOf(ctx, at)
}

export async function shapeOf(ctx: Ctx, at: string): Promise<Shape> {
  const tables = await readTables(at)
  const matches: Shape['matches'] = []
  for (const t of tables)
    for (const m of (await matchTable(ctx, t)).slice(0, 3)) matches.push({ ...m, table: t.name })
  return {
    path: relative(ctx.home.root, at),
    format: formatOf(at),
    tables: tables.map((t) => ({
      name: t.name,
      columns: t.columns,
      rows: t.rows.length,
      idColumns: idColumns(t),
      personal: t.columns.filter((c) => PERSONAL.test(c)),
      sample: t.rows.slice(0, 5),
    })),
    matches: matches.sort((a, b) => b.hits / b.of - a.hits / a.of),
    scripts: listScripts(ctx).filter((s) => takesFile(s.takes, at)),
  }
}

// --- Imports ---

export interface ImportOptions {
  importer: Format
  takes: string
  file: string
  sheet?: string
  query?: string
  collection: string
  type: string
  /** The id column. */
  id: string
  /** Rows without an id: held (written aside for a person or a view to settle), or skipped. */
  missing_id: 'hold' | 'skip'
  mode: 'set' | 'additions'
  where?: Record<string, unknown>
  /** Column → field; an empty field leaves the column out. */
  columns: Record<string, string>
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Options for importing a table into a type, filled in from the file and the schema. */
export function defaultOptions(
  ctx: Ctx,
  file: string,
  t: Table,
  o: { collection: string; type: string; id?: string; sheet?: string; personal?: boolean },
): ImportOptions {
  const ref = parseRef(o.collection, ctx.settings.defaultRemote)
  ctx.home.collection(ref)
  const schema = ctx.home.schemas(ref)[o.type] as
    | { properties?: Record<string, unknown> }
    | undefined
  const fields = Object.keys(schema?.properties ?? {})
  const id = o.id ?? idColumns(t)[0]
  if (!id) throw new CliError(`No column of ${t.name} looks like an id: say which with --id`)
  const columns: Record<string, string> = {}
  for (const col of t.columns) {
    if (col === id) continue
    const field = fields.find((f) => norm(f) === norm(col)) ?? (fields.length ? '' : col)
    columns[col] = PERSONAL.test(col) && !o.personal ? '' : field
  }
  return {
    importer: formatOf(file),
    takes: `*${extname(file).toLowerCase()}`,
    file: homeRel(ctx, fileArg(ctx, file) ?? file),
    ...(o.sheet ? { sheet: o.sheet } : {}),
    collection: keyOf(ref),
    type: o.type,
    id,
    missing_id: 'hold',
    mode: 'set',
    columns,
  }
}

/** A path in home as home-relative (`inputs/roster.xlsx`), else as it is. */
const homeRel = (ctx: Ctx, p: string) => {
  const rel = relative(ctx.home.root, p)
  return rel.startsWith('..') ? p : rel
}

/** Save an import's options in home's `scripts/imports/`. Its script name: `home/imports/<name>`. */
export function saveImport(ctx: Ctx, name: string, o: ImportOptions): string {
  const path = join(ctx.home.scriptsDir, 'imports', `${name}.toml`)
  const script = `home/imports/${name}`
  const file = TomlFile.read(
    path,
    `# A built-in import (underlay import). Run it with: underlay run ${script} [file]\n# Eject it to an editable script with: underlay eject ${script}\n`,
  )
  file.data = { ...o }
  file.write()
  return script
}

export function readImport(info: ScriptInfo): ImportOptions {
  return TomlFile.read(info.path).data as ImportOptions
}

/** An import's short name, for its held rows and decisions in inputs/. */
const importName = (info: ScriptInfo) => basename(info.path, '.toml')

/** Coerce a cell to what the schema's property wants, where it can. */
function coerce(v: unknown, prop: { type?: string | string[] } | undefined): unknown {
  const t = Array.isArray(prop?.type) ? prop!.type.find((x) => x !== 'null') : prop?.type
  if (typeof v === 'string') {
    if ((t === 'number' || t === 'integer') && v.trim() !== '' && !Number.isNaN(Number(v)))
      return Number(v)
    if (t === 'boolean' && /^(true|false|yes|no|1|0)$/i.test(v)) return /^(true|yes|1)$/i.test(v)
  }
  if (typeof v === 'number' && t === 'string') return String(v)
  return v
}

/** The held rows' file and the choices a view writes for them. */
export const heldPath = (ctx: Ctx, name: string) => join(ctx.home.inputsDir, `${name}-held.ndjson`)
export const decisionsPath = (ctx: Ctx, name: string) =>
  join(ctx.home.inputsDir, `${name}-decisions.json`)

/** Run an import: the table read, mapped to records, written as the collection's NDJSON. */
export async function runImport(
  ctx: Ctx,
  info: ScriptInfo,
  args: string[],
  out: string,
  log: (l: string) => void,
): Promise<{ mode?: 'additions' }> {
  const o = readImport(info)
  const file = fileArg(ctx, args[0] ?? o.file) ?? args[0] ?? o.file
  const t = await readTable(file, {
    ...(o.sheet ? { sheet: o.sheet } : {}),
    ...(o.query ? { query: o.query } : {}),
  })
  const ref = parseRef(o.collection, ctx.settings.defaultRemote)
  const schema = ctx.home.schemas(ref)[o.type] as
    | { properties?: Record<string, { type?: string }> }
    | undefined
  const name = importName(info)
  const decisions: Record<string, string | null> = existsSync(decisionsPath(ctx, name))
    ? JSON.parse(readFileSync(decisionsPath(ctx, name), 'utf8'))
    : {}
  const lines: string[] = []
  const held: string[] = []
  t.rows.forEach((row, i) => {
    let id = isEmpty(row[o.id]) ? null : String(row[o.id])
    const n = String(i + 2) // as a spreadsheet numbers it, under its header
    if (id === null && n in decisions) id = decisions[n] ?? null
    if (id === null) {
      if (o.missing_id === 'hold' && !(n in decisions))
        held.push(JSON.stringify({ row: Number(n), reason: `no ${o.id}`, data: row }))
      return
    }
    const data: Row = {}
    for (const [col, field] of Object.entries(o.columns)) {
      if (!field || isEmpty(row[col])) continue
      data[field] = coerce(row[col], schema?.properties?.[field])
    }
    lines.push(JSON.stringify({ id, type: o.type, data }))
  })
  const target = join(out, `${keyOf(ref)}.ndjson`)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, lines.join('\n') + (lines.length ? '\n' : ''))
  log(
    `Read ${t.rows.length} rows of ${basename(file)}${o.sheet ? ` (${o.sheet})` : ''}: ${lines.length} records of ${o.type} for ${keyOf(ref)}`,
  )
  if (held.length > 0) {
    writeFileSync(heldPath(ctx, name), held.join('\n') + '\n')
    log(`Held ${held.length} rows without an id: ${relative(ctx.home.root, heldPath(ctx, name))}`)
    log(
      `Choose for them in ${relative(ctx.home.root, decisionsPath(ctx, name))} ({"<row>": "<id>" or null}), and run again.`,
    )
    if (o.mode === 'set') {
      // Their records can't be told from the ones the file dropped: nothing is removed.
      log('With rows held, this run saves additions and changes only; nothing is removed.')
      return { mode: 'additions' }
    }
  }
  return {}
}

/** Turn an import into an editable script with its options written in. */
export function eject(ctx: Ctx, info: ScriptInfo): string {
  const o = readImport(info)
  const abs = info.path.replace(/\.toml$/, '.ts')
  const rel = homeRel(ctx, abs)
  if (existsSync(abs)) throw new CliError(`${rel} is there already`)
  const readArgs = [
    o.sheet ? `'--sheet', ${JSON.stringify(o.sheet)}` : '',
    o.query ? `'--query', ${JSON.stringify(o.query)}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  writeFileSync(
    abs,
    `// underlay: writes ${o.collection}
// underlay: takes ${o.takes}
// underlay: mode ${o.mode}
// underlay: types ${o.type}
// Ejected from ${info.name} on ${ctx.env.now().toISOString().slice(0, 10)}: edit freely.
// It reads the file with \`underlay read\` (rows as JSON objects) and writes the records.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const options = ${JSON.stringify({ file: o.file, collection: o.collection, type: o.type, id: o.id, columns: o.columns }, null, 2)}

const file = process.argv[2] ?? options.file
const rows = execFileSync('underlay', ['read', file${readArgs ? ', ' + readArgs : ''}], { maxBuffer: 1 << 30 })
  .toString()
  .split('\\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>)

const lines: string[] = []
for (const row of rows) {
  const id = row[options.id]
  if (id === undefined || id === null || id === '') {
    console.log('Held, no id:', JSON.stringify(row))
    continue
  }
  const data: Record<string, unknown> = {}
  for (const [column, field] of Object.entries(options.columns)) {
    if (field && row[column] !== undefined && row[column] !== '') data[field] = row[column]
  }
  lines.push(JSON.stringify({ id: String(id), type: options.type, data }))
}
const out = join(process.env.UNDERLAY_OUT!, options.collection + '.ndjson')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, lines.join('\\n') + '\\n')
console.log(\`\${lines.length} records of \${options.type}\`)
`,
  )
  if (o.where) {
    const side = TomlFile.read(abs.replace(/\.ts$/, '.toml'))
    side.data = { where: o.where }
    side.write()
  }
  return rel
}
