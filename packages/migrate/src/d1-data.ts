/**
 * Write a migrated SQLite database's rows as SQL for D1.
 *
 *   npx tsx packages/migrate/src/d1-data.ts migrated.sqlite [table,…] > data.sql
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
 */
import { createClient, type InValue } from '@libsql/client'

const file = process.argv[2]
/** Only these tables (e.g. rows a repair added to a database already loaded). */
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null
if (!file) {
  console.error('Usage: d1-data.ts <migrated.sqlite> [table,…]')
  process.exit(2)
}

const db = createClient({ url: `file:${file}` })
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
