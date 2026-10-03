/** SQLite on Cloudflare: D1. Migrations are applied by wrangler, not at runtime. */
import type { D1Database } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'

import type { Db } from '../ports.js'
import * as schema from './schema.js'

export function openD1(binding: D1Database): Db {
  // The D1 and libsql drivers build the same queries and both support batch();
  // the app is typed against one of them.
  return drizzle(binding, { schema }) as unknown as Db
}
