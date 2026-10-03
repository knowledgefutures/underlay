/**
 * Run the fake S3 server standalone, for `wrangler dev` smoke tests:
 *   npx tsx test/fake-s3-server.ts [port] [bucket]
 */
import { startFakeS3 } from './fake-s3.js'

const s3 = await startFakeS3(process.argv[3] ?? 'underlay-v2-staging', Number(process.argv[2] ?? 0))
console.log(`fake S3 at ${s3.url}`)
