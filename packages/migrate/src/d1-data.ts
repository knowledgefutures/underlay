/**
 * Write a migrated SQLite database's rows as SQL for D1.
 *
 *   npx tsx packages/migrate/src/d1-data.ts migrated.sqlite > data.sql
 *   wrangler d1 migrations apply <database> --env <env> --remote   (the schema)
 *   wrangler d1 execute <database> --env <env> --remote --file data.sql
 *
 * Data only: the schema comes from the D1 migrations, so D1's own migration
 * bookkeeping stays right and later migrations apply as usual. Rows are
 * `INSERT OR IGNORE`, so a row a migration already seeded (the platform
 * location) is kept rather than refused. Not OR REPLACE: replacing deletes the
 * row first, and the delete cascades to rows already imported (placements).
 * Foreign keys are checked at the end of the import, so table order doesn't
 * matter. Load into an empty database: existing rows win.
 */
import { createClient, type InValue } from '@libsql/client'

const file = process.argv[2]
if (!file) {
  console.error('Usage: d1-data.ts <migrated.sqlite>')
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
for (const { name } of tables.rows as unknown as { name: string }[]) {
  if (SKIP.test(name)) continue
  const rows = await db.execute(`SELECT * FROM "${name}"`)
  if (rows.rows.length === 0) continue
  const cols = rows.columns.map((c) => `"${c}"`).join(', ')
  for (const row of rows.rows) {
    const values = rows.columns.map((c) => literal(row[c] as InValue)).join(', ')
    out.write(`INSERT OR IGNORE INTO "${name}" (${cols}) VALUES (${values});\n`)
  }
  console.error(`[d1-data] ${name}: ${rows.rows.length}`)
}
