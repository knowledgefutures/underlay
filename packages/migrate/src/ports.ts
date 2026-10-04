/**
 * The ports a migration tool writes through: a local SQLite file standing in
 * for the deployment's D1, and the deployment's bucket. Shared by main.ts and
 * repair.ts; both read the same environment (see main.ts).
 */
import { ed25519Signer, generateSigningKey, s3Store, type Signer } from '@underlay/protocol'
import { createStores, MemoryCache, openNodeDb, type Ports, SqliteJobs } from '@underlay/server'

export async function migrationPorts(
  env: NodeJS.ProcessEnv,
): Promise<{ ports: Ports; signer: Signer }> {
  const db = await openNodeDb(env.TARGET_DB ?? 'file:./migrated.sqlite')
  const cache = new MemoryCache()
  const signer = await ed25519Signer(env.SIGNING_KEY ?? (await generateSigningKey()))
  const ports: Ports = {
    db,
    cache,
    stores: createStores(db, cache, {
      bucket: s3Store({
        endpoint: env.S3_ENDPOINT ?? '',
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
  return { ports, signer }
}
