/** SQLite on Node, through libsql: async with atomic batches, the same shape as D1. */
import { fileURLToPath } from 'node:url'

import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'

import type { Db } from '../ports.js'
import * as schema from './schema.js'

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** Open (and migrate) a database. `url` is `file:path/to/db.sqlite`, or `:memory:`. */
export async function openNodeDb(url: string): Promise<Db> {
  const client = createClient({ url })
  if (url !== ':memory:') await client.execute('PRAGMA journal_mode = WAL')
  await client.execute('PRAGMA foreign_keys = ON')
  await client.execute('PRAGMA busy_timeout = 5000')
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  return db
}
