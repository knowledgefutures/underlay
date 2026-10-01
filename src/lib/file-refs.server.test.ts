import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { insertFileRefs } from './file-refs.server.js'

const MIGRATION = resolve(__dirname, '../db/migrations/0017_version_file_refs.sql')

// Comments and layout don't matter; the statement does.
function normalize(statement: string): string {
  return statement
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
}

describe('version_file_refs backfill', () => {
  it('is the commit-time derivation with no version filter', () => {
    const rendered = new PgDialect().sqlToQuery(insertFileRefs(sql.raw('__ALL__'))).sql
    const expected = normalize(rendered).replace('WHERE __ALL__ AND ', 'WHERE ')

    const backfill = readFileSync(MIGRATION, 'utf8')
      .split('--> statement-breakpoint')
      .map(normalize)
      .find((s) => s.startsWith('INSERT INTO version_file_refs'))

    expect(backfill).toBe(expected)
  })
})
