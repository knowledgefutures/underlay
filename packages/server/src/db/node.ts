/** SQLite on Node, through libsql: async with atomic batches, the same shape as D1. */
import { fileURLToPath } from 'node:url'

import { type Client, createClient, type InStatement } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'

import type { Db } from '../ports.js'
import * as schema from './schema.js'

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** D1's limit on bound parameters per statement. libsql allows ~32k, so tests enforce it. */
export const D1_MAX_BOUND_PARAMS = 100

export interface NodeDbOptions {
  /** Throw on any statement binding more parameters than this (tests: D1's 100). */
  maxBoundParams?: number
  /** Called for every statement sent (tests count queries per request). */
  onStatement?: () => void
}

/** Open (and migrate) a database. `url` is `file:path/to/db.sqlite`, or `:memory:`. */
export async function openNodeDb(url: string, opts: NodeDbOptions = {}): Promise<Db> {
  let client = createClient({ url })
  if (url !== ':memory:') await client.execute('PRAGMA journal_mode = WAL')
  await client.execute('PRAGMA foreign_keys = ON')
  await client.execute('PRAGMA busy_timeout = 5000')
  if (opts.maxBoundParams !== undefined || opts.onStatement)
    client = guardParams(client, opts.maxBoundParams ?? Infinity, opts.onStatement)
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  return db
}

function boundParams(stmt: InStatement): number {
  if (typeof stmt === 'string' || !stmt.args) return 0
  return Array.isArray(stmt.args) ? stmt.args.length : Object.keys(stmt.args).length
}

/** A client that refuses statements D1 would refuse for their parameter count. */
function guardParams(client: Client, max: number, onStatement?: () => void): Client {
  const check = (stmt: InStatement) => {
    onStatement?.()
    const n = boundParams(stmt)
    if (n > max) {
      const text = typeof stmt === 'string' ? stmt : stmt.sql
      throw new Error(`Statement binds ${n} parameters (D1 allows ${max}): ${text.slice(0, 200)}`)
    }
  }
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (stmt: InStatement, ...rest: unknown[]) => {
          check(stmt)
          return (target.execute as (...a: unknown[]) => unknown).call(target, stmt, ...rest)
        }
      }
      if (prop === 'batch') {
        return (stmts: InStatement[], ...rest: unknown[]) => {
          stmts.forEach(check)
          return (target.batch as (...a: unknown[]) => unknown).call(target, stmts, ...rest)
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? (value as Function).bind(target) : value
    },
  })
}
