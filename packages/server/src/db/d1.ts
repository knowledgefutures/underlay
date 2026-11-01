/** SQLite on Cloudflare: D1. Migrations are applied by wrangler, not at runtime. */
import type { D1Database } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'

import type { Db } from '../ports.js'
import { setDbIdentity } from './identity.js'
import * as schema from './schema.js'

/**
 * `binding` is what queries go to (the database, or a request's session on it);
 * `database` is the database binding itself, which per-isolate caches key by.
 */
export function openD1(binding: D1Database, database: object = binding): Db {
  // The D1 and libsql drivers build the same queries and both support batch();
  // the app is typed against one of them.
  const db = drizzle(binding, { schema }) as unknown as Db
  setDbIdentity(db, database)
  return db
}
