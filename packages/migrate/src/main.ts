/**
 * Run a v1 → v2 migration.
 *
 *   V1_DATABASE_URL=postgres://…            the v1 database (read only)
 *   TARGET_DB=file:./migrated.sqlite        the v2 SQLite database to fill
 *   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY   the v2 bucket (R2)
 *   REPO_PREFIX (repo), INTERNAL_PREFIX (internal)
 *   SIGNING_KEY                             the target deployment's log key
 *   npx tsx packages/migrate/src/main.ts > report.json
 *
 * Then load the SQLite file into D1 (wrangler d1 export/import, or `.dump` and
 * `wrangler d1 execute --file --remote`). File objects aren't copied: point the
 * v2 bucket at the v1 bucket's keys or copy them first (build doc finding 16).
 */
import { ed25519Signer, generateSigningKey, s3Store } from '@underlay/protocol'
import {
  createStores,
  drainSqliteJobs,
  MemoryCache,
  openNodeDb,
  type Ports,
  SqliteJobs,
} from '@underlay/server'
import postgres from 'postgres'

import { migrateAll, type V1Db } from './convert.js'

const env = process.env
if (!env.V1_DATABASE_URL || !env.S3_ENDPOINT) {
  console.error(
    'Set V1_DATABASE_URL and the S3_* target bucket variables (see the header of this file).',
  )
  process.exit(2)
}

const sql = postgres(env.V1_DATABASE_URL, { max: 2 })
const v1: V1Db = {
  query: async (text, params) => (await sql.unsafe(text, (params ?? []) as never[])) as never,
}

const db = await openNodeDb(env.TARGET_DB ?? 'file:./migrated.sqlite')
const cache = new MemoryCache()
const signer = await ed25519Signer(env.SIGNING_KEY ?? (await generateSigningKey()))
const ports: Ports = {
  db,
  cache,
  stores: createStores(db, cache, {
    bucket: s3Store({
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET ?? 'underlay',
      accessKeyId: env.S3_ACCESS_KEY ?? '',
      secretAccessKey: env.S3_SECRET_KEY ?? '',
      region: env.S3_REGION ?? 'auto',
    }),
    repoPrefix: env.REPO_PREFIX ?? 'repo',
    internalPrefix: env.INTERNAL_PREFIX ?? 'internal',
  }),
  jobs: new SqliteJobs(db),
  signer: async () => signer,
  outboundFetch: () => Promise.reject(new Error('No outbound requests during migration')),
  waitUntil: (p) => void p.catch((err) => console.error(err)),
}

const started = Date.now()
const report = await migrateAll(v1, ports, {
  onCollection: (slug) => console.error(`[migrate] ${slug}`),
})
// Reference-log indexing and compaction run as jobs; finish them here.
await drainSqliteJobs(ports)
console.log(
  JSON.stringify({ ...report, seconds: Math.round((Date.now() - started) / 1000) }, null, 2),
)
await sql.end()
