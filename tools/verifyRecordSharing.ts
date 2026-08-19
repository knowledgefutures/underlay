/**
 * Verify that a metadata-only patch version sharing its base's `version_records`
 * rows is indistinguishable from one that copied them.
 *
 * Not part of `pnpm test`: it needs a real Postgres, and the rest of the suite is
 * pure unit tests that run anywhere. Point it at a SCRATCH database — it writes a
 * fixture and does not clean up:
 *
 *   createdb underlay_vrshare_test
 *   DATABASE_URL=postgresql://localhost:5432/underlay_vrshare_test pnpm db:migrate
 *   DATABASE_URL=postgresql://localhost:5432/underlay_vrshare_test pnpm tool:verifyRecordSharing
 *
 * The one that matters is "UNRESOLVED listing returns 0": that is the silent
 * failure every call site resolving through `recordsVersionId()` exists to avoid.
 */
import { eq, or, sql } from 'drizzle-orm'

import { db, schema } from '../src/db/client.server.js'
import { hashRecord } from '../src/lib/core/hash.js'
import { recordsVersionId } from '../src/lib/version-helpers.server.js'

const fail: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name} ${detail}`)
    fail.push(name)
  }
}

async function main() {
  // --- fixture ---
  const orgId = 'org_test'
  await db
    .insert(schema.organization)
    .values({ id: orgId, name: 'Test Org', slug: 'test-org', createdAt: new Date() })
    .onConflictDoNothing()

  const [coll] = await db
    .insert(schema.collections)
    .values({ organizationId: orgId, slug: 'c1', name: 'C1', public: true })
    .returning()

  const RECORDS = [
    { id: 'r1', type: 'Thing', data: { a: 1 } },
    { id: 'r2', type: 'Thing', data: { a: 2 } },
    { id: 'r3', type: 'Other', data: { a: 3 } },
  ]
  const withHash = RECORDS.map((r) => ({ ...r, hash: hashRecord(r).hash }))
  await db
    .insert(schema.recordObjects)
    .values(
      withHash.map((r) => ({
        hash: r.hash,
        recordId: r.id,
        type: r.type,
        data: r.data,
        size: JSON.stringify(r.data).length,
      })),
    )
    .onConflictDoNothing()

  // base version owns its rows
  const [base] = await db
    .insert(schema.versions)
    .values({
      collectionId: coll!.id,
      semver: 'v1.0.0',
      major: 1,
      minor: 0,
      patch: 0,
      hash: 'private:base',
      publicHash: 'public:base',
      recordCount: withHash.length,
      fileCount: 0,
      totalBytes: 10,
      metadata: { readme: 'old' },
      typeCounts: { Thing: 2, Other: 1 },
    })
    .returning()

  await db.insert(schema.versionRecords).values(
    withHash.map((r) => ({
      versionId: base!.id,
      recordHash: r.hash,
      recordId: r.id,
      type: r.type,
      private: false,
    })),
  )

  // metadata patch shares the base's rows
  const [patch] = await db
    .insert(schema.versions)
    .values({
      collectionId: coll!.id,
      semver: 'v1.0.1',
      major: 1,
      minor: 0,
      patch: 1,
      hash: 'private:patch',
      publicHash: 'public:patch',
      baseSemver: 'v1.0.0',
      recordCount: base!.recordCount,
      fileCount: 0,
      totalBytes: base!.totalBytes,
      metadata: { readme: 'new' },
      typeCounts: base!.typeCounts,
      recordsFromVersionId: recordsVersionId(base!),
    })
    .returning()

  console.log(`\nbase=${base!.id} patch=${patch!.id} sharesFrom=${patch!.recordsFromVersionId}\n`)

  // --- assertions ---
  check('patch owns zero rows of its own', await countRows(patch!.id, false), '')
  check('pointer names the base', patch!.recordsFromVersionId === base!.id)
  check('recordsVersionId(patch) === base.id', recordsVersionId(patch!) === base!.id)

  // record listing, the way versions.ts does it
  const listed = await db
    .select({ recordId: schema.versionRecords.recordId })
    .from(schema.versionRecords)
    .where(eq(schema.versionRecords.versionId, recordsVersionId(patch!)))
  check('resolved listing returns all 3 records', listed.length === 3, `got ${listed.length}`)

  const unresolved = await db
    .select({ recordId: schema.versionRecords.recordId })
    .from(schema.versionRecords)
    .where(eq(schema.versionRecords.versionId, patch!.id))
  check(
    'UNRESOLVED listing returns 0 — this is the failure mode',
    unresolved.length === 0,
    `got ${unresolved.length}`,
  )

  // raw-SQL streaming path (digest fold source)
  const client = db.$client
  const streamed: string[] = []
  await client`
    SELECT record_hash AS h FROM version_records
    WHERE version_id = ${recordsVersionId(patch!)}
    ORDER BY record_hash COLLATE "C"
  `.cursor(1000, (rows) => {
    for (const row of rows) streamed.push(row['h'] as string)
  })
  check('digest stream sees all 3 hashes', streamed.length === 3, `got ${streamed.length}`)
  check('stream is byte-sorted', streamed.join() === [...streamed].sort().join(), streamed.join())

  // diff base→patch must be empty in both directions
  const diff = (selfId: number, otherId: number) => sql`
    SELECT count(*)::int AS n FROM version_records vr
    WHERE vr.version_id = ${selfId}
      AND NOT EXISTS (
        SELECT 1 FROM version_records s
        WHERE s.version_id = ${otherId} AND s.record_id = vr.record_id
      )`
  const [added] = (await db.execute(
    diff(recordsVersionId(patch!), recordsVersionId(base!)),
  )) as unknown as { n: number }[]
  const [removed] = (await db.execute(
    diff(recordsVersionId(base!), recordsVersionId(patch!)),
  )) as unknown as { n: number }[]
  check('diff added === 0', added!.n === 0, `got ${added!.n}`)
  check('diff removed === 0', removed!.n === 0, `got ${removed!.n}`)

  // provenance: the OR join must find BOTH versions for a shared record
  const refs = await db
    .select({ semver: schema.versions.semver })
    .from(schema.versionRecords)
    .innerJoin(
      schema.versions,
      or(
        eq(schema.versionRecords.versionId, schema.versions.id),
        eq(schema.versionRecords.versionId, schema.versions.recordsFromVersionId),
      ),
    )
    .where(eq(schema.versionRecords.recordHash, withHash[0]!.hash))
  const semvers = refs.map((r) => r.semver).sort()
  check(
    'provenance lists base AND patch',
    semvers.join() === 'v1.0.0,v1.0.1',
    semvers.join() || '(none)',
  )

  // RESTRICT must refuse to delete a shared base
  let restricted = false
  try {
    await db.delete(schema.versions).where(eq(schema.versions.id, base!.id))
  } catch {
    restricted = true
  }
  check('deleting a shared base is refused by RESTRICT', restricted)

  // a second consecutive metadata edit must stay one hop
  const [patch2] = await db
    .insert(schema.versions)
    .values({
      collectionId: coll!.id,
      semver: 'v1.0.2',
      major: 1,
      minor: 0,
      patch: 2,
      hash: 'private:patch2',
      publicHash: 'public:patch2',
      recordCount: base!.recordCount,
      fileCount: 0,
      totalBytes: base!.totalBytes,
      metadata: { readme: 'newer' },
      recordsFromVersionId: recordsVersionId(patch!),
    })
    .returning()
  check(
    'chained patch points at the OWNER, not the patch',
    patch2!.recordsFromVersionId === base!.id,
    `points at ${patch2!.recordsFromVersionId}, base is ${base!.id}`,
  )
  const listed2 = await db
    .select({ recordId: schema.versionRecords.recordId })
    .from(schema.versionRecords)
    .where(eq(schema.versionRecords.versionId, recordsVersionId(patch2!)))
  check('chained patch resolves to 3 records', listed2.length === 3, `got ${listed2.length}`)

  console.log(
    fail.length === 0 ? '\nALL PASSED\n' : `\n${fail.length} FAILED: ${fail.join(', ')}\n`,
  )
  process.exit(fail.length === 0 ? 0 : 1)
}

async function countRows(versionId: number, expectSome: boolean) {
  const [row] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM version_records WHERE version_id = ${versionId}`,
  )) as unknown as { n: number }[]
  return expectSome ? row!.n > 0 : row!.n === 0
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
