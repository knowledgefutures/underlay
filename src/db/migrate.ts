import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://underlay:underlay@localhost:5432/underlay'

export async function runMigrations(retries = 10, delay = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const client = postgres(connectionString, { max: 1 })
    try {
      console.log(`[migrate] Running migrations (attempt ${attempt})...`)
      await migrate(drizzle(client), { migrationsFolder: './src/db/migrations' })
      console.log('[migrate] Done.')
      return
    } catch (err: any) {
      const code = err?.cause?.code ?? err?.code
      const isTransient = code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT'
      if (isTransient && attempt < retries) {
        console.log(`[migrate] DB not ready (${code}), retrying in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
      } else {
        throw err
      }
    } finally {
      await client.end()
    }
  }
}

// Run directly if invoked as a script
const isMain = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')

if (isMain) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] Failed:', err)
      process.exit(1)
    })
}
