import { defineConfig } from 'drizzle-kit'

// One migration set for both runtimes: libsql applies it with drizzle's
// migrator, D1 with `wrangler d1 migrations apply` (migrations_dir = drizzle/).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
