/**
 * Write a migrated SQLite database's rows as SQL for D1.
 *
 *   npx tsx packages/migrate/src/d1-data.ts migrated.sqlite [table,…] > data.sql
 *   npx tsx packages/migrate/src/d1-data.ts migrated.sqlite --since loaded.sqlite > delta.sql
 *   wrangler d1 migrations apply <database> --env <env> --remote   (the schema)
 *   wrangler d1 execute <database> --env <env> --remote --file data.sql
 *
 * Data only: the schema comes from the D1 migrations, so D1's own migration
 * bookkeeping stays right and later migrations apply as usual. Rows are
 * `INSERT OR IGNORE`, so a row a migration already seeded (the platform
 * location) is kept rather than refused. Not OR REPLACE: replacing deletes the
 * row first, and the delete cascades to rows already imported (placements).
 * Tables are written parents first, by their foreign keys: D1's remote import
 * doesn't keep `defer_foreign_keys` across the file, so a child row ahead of its
 * parent failed the whole import (found loading dev into staging). The pragma
 * stays for any cycle. Load into an empty database: existing rows win.
 *
 * `--since` writes only what changed from an earlier copy of the same file (the
 * one last loaded into D1) to this one, after a sync run (SYNC=1, main.ts): new
 * and changed rows as upserts on the primary key, parents first, then rows that
 * are gone as deletes, children first. Rows D1 has that neither file has (made on
 * the deployment itself) are left alone.
 */
import { type Client, createClient, type InValue } from '@libsql/client'

const args = process.argv.slice(2)
const sinceAt = args.indexOf('--since')
const sinceFile = sinceAt >= 0 ? args.splice(sinceAt, 2)[1] : null
const file = args[0]
/** Only these tables (e.g. rows a repair added to a database already loaded). */
const only = args[1] ? new Set(args[1].split(',')) : null
if (!file || (sinceAt >= 0 && !sinceFile)) {
  console.error('Usage: d1-data.ts <migrated.sqlite> [table,…] [--since <loaded.sqlite>]')
  process.exit(2)
}

const db = createClient({ url: `file:${file}` })
const since = sinceFile ? createClient({ url: `file:${sinceFile}` }) : null
const SKIP = /^(sqlite_|_cf_|__drizzle_migrations$|d1_migrations$)/

function literal(v: InValue): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer)
    return `X'${Buffer.from(bytes).toString('hex')}'`
  }
  return `'${String(v).replaceAll("'", "''")}'`
}

const out = process.stdout
out.write('PRAGMA defer_foreign_keys = true;\n')
const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
const names = (tables.rows as unknown as { name: string }[])
  .map((r) => r.name)
  .filter((n) => !SKIP.test(n) && (!only || only.has(n)))
const parents = new Map<string, string[]>()
for (const n of names) {
  const fks = await db.execute(`SELECT DISTINCT "table" AS t FROM pragma_foreign_key_list('${n}')`)
  const ts = (fks.rows as unknown as { t: string }[]).map((r) => r.t)
  parents.set(
    n,
    ts.filter((t) => t !== n && names.includes(t)),
  )
}
const ordered: string[] = []
while (ordered.length < names.length) {
  const ready = names.filter(
    (n) => !ordered.includes(n) && parents.get(n)!.every((p) => ordered.includes(p)),
  )
  if (ready.length === 0) {
    const rest = names.filter((n) => !ordered.includes(n))
    console.error(`[d1-data] foreign key cycle among ${rest.join(', ')}; relying on deferral`)
    ordered.push(...rest)
    break
  }
  ordered.push(...ready)
}

if (!since) {
  for (const name of ordered) {
    const rows = await db.execute(`SELECT * FROM "${name}"`)
    if (rows.rows.length === 0) continue
    const cols = rows.columns.map((c) => `"${c}"`).join(', ')
    for (const row of rows.rows) {
      const values = rows.columns.map((c) => literal(row[c] as InValue)).join(', ')
      out.write(`INSERT OR IGNORE INTO "${name}" (${cols}) VALUES (${values});\n`)
    }
    console.error(`[d1-data] ${name}: ${rows.rows.length}`)
  }
} else {
  /** A table's rows as primary key → its values as SQL literals. */
  async function keyed(c: Client, name: string, pk: string[]) {
    const exists = await c.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [name],
    })
    const rows = new Map<string, Map<string, string>>()
    if (exists.rows.length === 0) return rows
    const res = await c.execute(`SELECT * FROM "${name}"`)
    for (const row of res.rows) {
      const values = new Map(res.columns.map((col) => [col, literal(row[col] as InValue)]))
      const key = (pk.length ? pk : res.columns).map((col) => values.get(col)).join('\u0000')
      rows.set(key, values)
    }
    return rows
  }
  const deletes: string[][] = []
  for (const name of ordered) {
    const info = await db.execute(`SELECT name, pk FROM pragma_table_info('${name}')`)
    const pk = (info.rows as unknown as { name: string; pk: number }[])
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name)
    const [now, before] = [await keyed(db, name, pk), await keyed(since, name, pk)]
    let upserts = 0
    for (const [key, values] of now) {
      const old = before.get(key)
      if (old && [...values].every(([col, v]) => old.get(col) === v)) continue
      const cols = [...values.keys()]
      const head = `INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${[...values.values()].join(', ')})`
      const rest = cols.filter((c) => !pk.includes(c))
      // No primary key, or nothing but the key: the row is all there is to add.
      out.write(
        pk.length && rest.length
          ? `${head} ON CONFLICT (${pk.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${rest.map((c) => `"${c}" = excluded."${c}"`).join(', ')};\n`
          : `${head.replace(/^INSERT/, 'INSERT OR IGNORE')};\n`,
      )
      upserts++
    }
    const gone: string[] = []
    for (const [key, values] of before) {
      if (now.has(key)) continue
      const where = (pk.length ? pk : [...values.keys()])
        .map((c) => (values.get(c) === 'NULL' ? `"${c}" IS NULL` : `"${c}" = ${values.get(c)}`))
        .join(' AND ')
      gone.push(`DELETE FROM "${name}" WHERE ${where};`)
    }
    deletes.push(gone)
    if (upserts || gone.length)
      console.error(`[d1-data] ${name}: ${upserts} new or changed, ${gone.length} gone`)
  }
  // Children first, so a delete never waits on a child row that's going too.
  for (const gone of deletes.reverse()) for (const line of gone) out.write(`${line}\n`)
}
