import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema.js'

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://underlay:underlay@localhost:5432/underlay'

const client = postgres(connectionString)
export const db = drizzle(client, { schema })
export { schema }
