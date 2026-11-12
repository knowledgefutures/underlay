/**
 * fsck for a v3 collection (POST /api/admin/fsck; v3-deploy-plan.md, Phase 3), in the job
 * chain v2's uses (handlers.ts `repo.fsckStep`) and with its report.
 *
 * The first step checks the log (`verifyLog`: numbers without gaps, each commit naming the
 * one before, semvers that follow, the server's signature, the collection ids its lineage
 * allows, and, for the commits after the newest layout, each named file's footer against
 * the commit), that each file the newest layout lists is stored, D1's versions against the
 * commits, and that each asset the head lists is stored at its size. With `fileBytes`, the
 * steps after it read every sorted-record-file the collection lists in full (`verifyFile`),
 * a few a step. An asset's bytes are not hashed: they were checked against their name when
 * they were installed.
 *
 * The report's counts, in v2's names: `versions` commits checked, `files` assets,
 * `leaves` sorted-record-files read in full, `records` their entries.
 */
import { type FsckReport, v3 } from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { assetsOf, headView } from './catalog.js'
import { assetKey } from './rules.js'

export interface V3FsckCursor {
  /** The next sorted-record-file to read in full, by its place in the collection's list. */
  v3File: number
}

export const v3FsckConfig = { filesPerStep: 8, concurrency: 4, maxErrors: 100 }

export async function v3FsckStep(
  ports: Ports,
  collectionId: string,
  opts: { fileBytes: boolean; cursor: V3FsckCursor | null },
): Promise<{ report: FsckReport; cursor: V3FsckCursor | null }> {
  const store = ports.stores.v3
  const report: FsckReport = {
    ok: true,
    errors: [],
    moreErrors: 0,
    versions: 0,
    trees: 0,
    nodes: 0,
    leaves: 0,
    records: 0,
    files: 0,
    log: 'trusted keys',
  }
  const problem = (what: string) => {
    report.ok = false
    if (report.errors.length < v3FsckConfig.maxErrors) report.errors.push(what)
    else report.moreErrors++
  }

  /** A part of the check that cannot go on is a problem in the report, not a failed job. */
  const checking = async (what: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      problem(`${what}: ${(err as Error).message}`)
    }
  }

  if (!opts.cursor) {
    const head = await v3.headNumber(store, collectionId)
    // The first commit writes the description.
    const description = await v3.readDescription(store, collectionId)
    if (!description && head > 0) problem(`${collectionId} has no description`)
    const own = (await ports.signer()).publicKey
    // The files of commits a layout covers are replaced by the layout's, and swept: a
    // commit's files are checked only after the newest layout, and the layout's are below.
    const layout = await v3.findLayout(store, collectionId)
    try {
      const last = await v3.verifyLog(store, collectionId, {
        ...(description?.lineage ? { lineage: description.lineage } : {}),
        files: true,
        filesFrom: (layout?.through ?? 0) + 1,
        serverKeys: [own],
      })
      report.versions = last?.commit.number ?? 0
    } catch (err) {
      problem((err as Error).message)
    }

    // Every file the newest layout lists, stored.
    await checking('The layout', async () => {
      const listed = layout?.files ?? []
      const found = await v3.inParallel(
        listed.map((f) => () => store.head(v3.recordKey(f.id))),
        16,
      )
      for (const [i, f] of listed.entries())
        if (!found[i]) problem(`File ${f.id} of layout ${layout!.number} is not stored`)
    })

    // D1's catalog against the log: a row a commit, with the commit's id.
    await checking('The catalog', async () => {
      const rows = await ports.db
        .select({ seq: schema.versions.seq, hash: schema.versions.hash })
        .from(schema.versions)
        .where(eq(schema.versions.collectionId, collectionId))
      if (rows.length !== head)
        problem(`D1 has ${rows.length} versions of ${collectionId}; its log has ${head} commits`)
      const commits = await v3.inParallel(
        rows.map((r) => () => v3.readCommit(store, collectionId, r.seq)),
        16,
      )
      for (const [i, r] of rows.entries()) {
        const c = commits[i]
        if (!c) problem(`D1 has version ${r.seq}, which the log does not`)
        else if (c.id !== r.hash) problem(`Version ${r.seq} is ${c.id} in the log, ${r.hash} in D1`)
      }
    })

    // Every asset the head lists, stored at its size.
    await checking('The assets', async () => {
      const assets = await assetsOf(store, await headView(store, collectionId))
      const found = await v3.inParallel(
        [...assets.keys()].map((h) => () => store.head(assetKey(h))),
        16,
      )
      for (const [i, [hash, a]] of [...assets].entries()) {
        const obj = found[i]
        if (!obj) problem(`Asset ${hash} is not stored`)
        else if (obj.size !== a.size)
          problem(`Asset ${hash} is ${obj.size} bytes, listed as ${a.size}`)
      }
      report.files = assets.size
    })
    return { report, cursor: opts.fileBytes ? { v3File: 0 } : null }
  }

  const { files } = await v3.currentFiles(store, collectionId)
  const from = opts.cursor.v3File
  const part = files.slice(from, from + v3FsckConfig.filesPerStep)
  await v3.inParallel(
    part.map((f) => async () => {
      try {
        const r = await v3.verifyFile(store, v3.recordKey(f.id), { id: f.id })
        report.leaves++
        report.records += r.content.entries
      } catch (err) {
        problem((err as Error).message)
      }
    }),
    v3FsckConfig.concurrency,
  )
  const next = from + part.length
  return { report, cursor: next < files.length ? { v3File: next } : null }
}
