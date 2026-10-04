/**
 * Run a v1 → v2 migration.
 *
 *   V1_DATABASE_URL=postgres://…            the v1 database (read only), or:
 *   V1_SSH="-i key -o BatchMode=yes user@host" and V1_CONTAINER=<swarm service>_postgres
 *                                           read it with docker exec … psql on that host
 *                                           (src/ssh-psql.ts); the container's name must
 *                                           start with "<V1_CONTAINER>."
 *   TARGET_DB=file:./migrated.sqlite        the v2 SQLite database to fill
 *   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY   the v2 bucket (R2)
 *   REPO_PREFIX (repo), INTERNAL_PREFIX (internal)
 *   SIGNING_KEY                             the target deployment's log key
 *   V1_S3_ENDPOINT, V1_S3_BUCKET, V1_S3_ACCESS_KEY, V1_S3_SECRET_KEY
 *                                           the v1 bucket: when set, file objects are
 *                                           copied to their v2 keys (src/files.ts)
 *   FILES_ONLY=1                            only copy files, into an existing TARGET_DB
 *   COLLECTIONS=owner/slug,…                convert only these collections (ids work too);
 *                                           accounts and files are still copied whole
 *   npx tsx packages/migrate/src/main.ts > report.json
 *
 * Then load the SQLite file into D1 (wrangler d1 export/import, or `.dump` and
 * `wrangler d1 execute --file --remote`).
 */
import { s3Store } from '@underlay/protocol'
import { drainSqliteJobs } from '@underlay/server'
import postgres from 'postgres'

import { migrateAll, type V1Db } from './convert.js'
import { copyFiles } from './files.js'
import { migrationPorts } from './ports.js'
import { sshPsql } from './ssh-psql.js'

const env = process.env
const filesOnly = env.FILES_ONLY === '1'
if ((!env.V1_DATABASE_URL && !env.V1_SSH && !filesOnly) || !env.S3_ENDPOINT) {
  console.error(
    'Set V1_DATABASE_URL and the S3_* target bucket variables (see the header of this file).',
  )
  process.exit(2)
}

const sql = postgres(env.V1_DATABASE_URL ?? '', { max: 2 })
const ssh =
  env.V1_SSH && !filesOnly
    ? await sshPsql({
        ssh: env.V1_SSH.split(/\s+/).map((a) => a.replace(/^~(?=\/)/, env.HOME ?? '~')),
        container: env.V1_CONTAINER ?? '',
        requirePrefix: `${env.V1_CONTAINER}.`,
      })
    : null
const v1: V1Db = ssh ?? {
  query: async (text, params) => (await sql.unsafe(text, (params ?? []) as never[])) as never,
}

const { ports } = await migrationPorts(env)

const started = Date.now()
let report: object = {}
if (!filesOnly) {
  report = await migrateAll(v1, ports, {
    onCollection: (slug) => console.error(`[migrate] ${slug}`),
    ...(env.COLLECTIONS && { collections: env.COLLECTIONS.split(',').map((c) => c.trim()) }),
  })
  // Reference-log indexing and compaction run as jobs; finish them here.
  await drainSqliteJobs(ports)
}
if (env.V1_S3_BUCKET) {
  const source = s3Store({
    endpoint: env.V1_S3_ENDPOINT ?? env.S3_ENDPOINT,
    bucket: env.V1_S3_BUCKET,
    accessKeyId: env.V1_S3_ACCESS_KEY ?? '',
    secretAccessKey: env.V1_S3_SECRET_KEY ?? '',
    region: 'auto',
  })
  const files = await copyFiles(source, ports, {
    onFile: (_, done, total) => {
      if (done % 100 === 0 || done === total) console.error(`[files] ${done}/${total}`)
    },
  })
  report = { ...report, files }
}
console.log(
  JSON.stringify({ ...report, seconds: Math.round((Date.now() - started) / 1000) }, null, 2),
)
ssh?.close()
await sql.end()
