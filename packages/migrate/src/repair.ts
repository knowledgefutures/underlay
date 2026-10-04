/**
 * Bring a converted deployment up to the current format without converting it
 * again (edge-redesign-build.md, "Deployment targets"). Written for staging after
 * the alignment-review fixes, when the data was right but the logs and file
 * possession were not.
 *
 *   TARGET_DB=file:./migrated.sqlite   the converted database, as loaded into D1
 *   S3_*, REPO_PREFIX, SIGNING_KEY      the deployment's bucket and log key (main.ts)
 *   COLLECTIONS=owner/slug,…           only these collections (default: all)
 *   STEPS=logs,possession,refs         which steps (default: logs,possession)
 *   REFS_SQL=./refs.sql                where the refs step writes its D1 updates
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
 * 3. **Refs** (2026-10-04). Rebuilds the head version's file reference count
 *    trees with per-type counts, so moving or removing a type stops reading its
 *    records (packages/protocol/src/repo/file-sets.ts). Only heads whose trees
 *    lack them; a null tree needs nothing. Writes `UPDATE versions …` lines to
 *    REFS_SQL for `wrangler d1 execute --file` (d1-data.ts only inserts).
 * Then every rewritten log is verified against the signing key.
 */
import { appendFileSync, writeFileSync } from 'node:fs'

import {
  emptySet,
  fileTree,
  iterate,
  listAll,
  rebuildFileRefs,
  RepoSource,
  tracksTypes,
  verifyLog,
} from '@underlay/protocol'
import { appendVersionLog, dbSchema as schema } from '@underlay/server'
import { asc, eq } from 'drizzle-orm'

import { recordPossession } from './convert.js'
import { migrationPorts } from './ports.js'

const env = process.env
const { ports, signer } = await migrationPorts(env)
const { db } = ports

const steps = new Set((env.STEPS ?? 'logs,possession').split(',').map((s) => s.trim()))
const refsSql = env.REFS_SQL ?? './refs.sql'
if (steps.has('refs')) writeFileSync(refsSql, '')
const sqlText = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)

const wanted = env.COLLECTIONS ? new Set(env.COLLECTIONS.split(',').map((c) => c.trim())) : null
const cols = (
  await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      headVersionId: schema.collections.headVersionId,
      owner: schema.organization.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
).filter((c) => !wanted || wanted.has(c.id) || wanted.has(`${c.owner}/${c.slug}`))

const report: {
  collection: string
  versions: number
  possession?: number
  refs?: 'rebuilt' | 'current'
}[] = []
for (const c of cols) {
  const repo = await ports.stores.forCollection(c.id)
  const versions = await db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, c.id))
    .orderBy(asc(schema.versions.seq))

  const line: (typeof report)[number] = {
    collection: `${c.owner}/${c.slug}`,
    versions: versions.length,
  }

  // 1. Logs, from scratch.
  if (steps.has('logs')) {
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
  }

  // 2. Possession of every file a version held.
  if (steps.has('possession')) {
    const held = new Set<string>()
    const files = new RepoSource(fileTree, repo)
    for (const v of versions) {
      const root = await repo.root(v.hash)
      const sets = [root.public, ...(root.private ? [await repo.privateSet(root.private)] : [])]
      for (const set of sets) for await (const f of iterate(files, set.files.root)) held.add(f.key)
    }
    await db.delete(schema.fileUploads).where(eq(schema.fileUploads.collectionId, c.id))
    line.possession = await recordPossession(ports, c.id, held)
  }

  // 3. Per-type counts in the head's reference count trees.
  const head = versions.find((v) => v.id === c.headVersionId)
  if (steps.has('refs') && head) {
    const current =
      (await tracksTypes(repo, head.publicRefsRoot)) &&
      (await tracksTypes(repo, head.privateRefsRoot))
    if (current) line.refs = 'current'
    else {
      const root = await repo.root(head.hash)
      const priv = root.private ? await repo.privateSet(root.private) : emptySet()
      const refs = await rebuildFileRefs(repo, { public: root.public, private: priv })
      appendFileSync(
        refsSql,
        `UPDATE versions SET public_refs_root = ${sqlText(refs.public)}, private_refs_root = ${sqlText(refs.private)} WHERE id = ${sqlText(head.id)};\n`,
      )
      await db
        .update(schema.versions)
        .set({ publicRefsRoot: refs.public, privateRefsRoot: refs.private })
        .where(eq(schema.versions.id, head.id))
      line.refs = 'rebuilt'
    }
  }

  report.push(line)
  console.error(`[repair] ${JSON.stringify(line)}`)
}
console.log(JSON.stringify(report, null, 2))
