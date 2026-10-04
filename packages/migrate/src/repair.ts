/**
 * Bring a converted deployment up to the current format without converting it
 * again (edge-redesign-build.md, "Deployment targets"). Written for staging after
 * the alignment-review fixes, when the data was right but the logs and file
 * possession were not.
 *
 *   TARGET_DB=file:./migrated.sqlite   the converted database, as loaded into D1
 *   S3_*, REPO_PREFIX, SIGNING_KEY      the deployment's bucket and log key (main.ts)
 *   COLLECTIONS=owner/slug,…           only these collections (default: all)
 *   npx tsx packages/migrate/src/repair.ts
 *
 * Per collection:
 * 1. **Logs.** Deletes `collections/<id>/` (collection.json, log entries, head.json)
 *    and writes the log again from the versions table with appendVersionLog, so
 *    entries take the current format (B8: they sign the collection id). The
 *    versions themselves are untouched; only the signed record of them changes.
 * 2. **Possession.** A verified file_uploads row for every file any version held
 *    (both sets' file trees), as the converter now writes (B2). Rows go into
 *    TARGET_DB; load them with `d1-data.ts <db> file_uploads`.
 * Then every rewritten log is verified against the signing key.
 */
import { fileTree, iterate, listAll, RepoSource, verifyLog } from '@underlay/protocol'
import { appendVersionLog, dbSchema as schema } from '@underlay/server'
import { asc, eq } from 'drizzle-orm'

import { recordPossession } from './convert.js'
import { migrationPorts } from './ports.js'

const env = process.env
const { ports, signer } = await migrationPorts(env)
const { db } = ports

const wanted = env.COLLECTIONS ? new Set(env.COLLECTIONS.split(',').map((c) => c.trim())) : null
const cols = (
  await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      owner: schema.organization.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
).filter((c) => !wanted || wanted.has(c.id) || wanted.has(`${c.owner}/${c.slug}`))

const report: { collection: string; versions: number; possession: number }[] = []
for (const c of cols) {
  const repo = await ports.stores.forCollection(c.id)
  const versions = await db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, c.id))
    .orderBy(asc(schema.versions.seq))

  // 1. Logs, from scratch.
  const old: string[] = []
  for await (const k of listAll(repo.blobs, `collections/${c.id}/`)) old.push(k)
  for (const k of old) await repo.blobs.delete(k)
  for (const v of versions) await appendVersionLog(ports, repo, c.id, v)
  // A collection with no versions has no log.
  const { entries } =
    versions.length > 0 ? await verifyLog(repo, c.id, [signer.publicKey]) : { entries: [] }
  if (entries.length !== versions.length) {
    throw new Error(
      `${c.owner}/${c.slug}: ${entries.length} log entries for ${versions.length} versions`,
    )
  }

  // 2. Possession of every file a version held.
  const held = new Set<string>()
  const files = new RepoSource(fileTree, repo)
  for (const v of versions) {
    const root = await repo.root(v.hash)
    const sets = [root.public, ...(root.private ? [await repo.privateSet(root.private)] : [])]
    for (const set of sets) for await (const f of iterate(files, set.files.root)) held.add(f.key)
  }
  await db.delete(schema.fileUploads).where(eq(schema.fileUploads.collectionId, c.id))
  const possession = await recordPossession(ports, c.id, held)

  report.push({ collection: `${c.owner}/${c.slug}`, versions: versions.length, possession })
  console.error(
    `[repair] ${c.owner}/${c.slug}: ${versions.length} log entries, ${possession} files`,
  )
}
console.log(JSON.stringify(report, null, 2))
