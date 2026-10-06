/**
 * File sets on the platform: the protocol package's file-set bookkeeping
 * (src/repo/file-sets.ts), with file sizes from the files table.
 */
import {
  applyFileSet as applyFileSetWith,
  type FileSetResult,
  fileTree,
  getEntry,
  type Repo,
  RepoSource,
  type TreeSummary,
} from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

/** File sizes for hashes, from the files table: a query per JSON_CHUNK hashes. */
export async function fileSizes(db: Db, hashes: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const part of chunks(hashes, JSON_CHUNK)) {
    const rows = await db
      .select({ hash: schema.files.hash, size: schema.files.size })
      .from(schema.files)
      .where(inJson(schema.files.hash, part))
    for (const r of rows) out.set(r.hash, r.size)
  }
  return out
}

/**
 * Sizes of the files a commit to this collection may reference. A file counts
 * only if the collection already has it (the base version's file trees, or its
 * cumulative public files tree) or its bytes were uploaded and verified under
 * this collection. Anything else is missing, whether or not another collection
 * holds it, so a commit can't learn of or borrow another collection's file by
 * hash (edge-redesign.md, Security notes).
 */
export async function collectionFileSizes(
  db: Db,
  repo: Repo,
  collection: { id: string; publicFilesRoot: string | null },
  baseHash: string | null,
  hashes: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (hashes.length === 0) return out
  const roots = [collection.publicFilesRoot]
  if (baseHash) {
    const root = await repo.root(baseHash)
    roots.push(root.public.files.root)
    if (root.private) roots.push((await repo.privateSet(root.private)).files.root)
  }
  const source = new RepoSource(fileTree, repo)
  const rest: string[] = []
  for (const h of hashes) {
    let size: number | undefined
    for (const r of roots) {
      if (!r) continue
      size = (await getEntry(source, r, h))?.size
      if (size !== undefined) break
    }
    if (size === undefined) rest.push(h)
    else out.set(h, size)
  }
  for (const part of chunks(rest, JSON_CHUNK)) {
    const rows = await db
      .select({ hash: schema.files.hash, size: schema.files.size })
      .from(schema.files)
      .innerJoin(schema.fileUploads, eq(schema.fileUploads.hash, schema.files.hash))
      .where(
        and(
          inJson(schema.files.hash, part),
          eq(schema.fileUploads.collectionId, collection.id),
          eq(schema.fileUploads.status, 'verified'),
        ),
      )
    for (const r of rows) out.set(r.hash, r.size)
  }
  return out
}

/** Apply a set's reference deltas to its count and file trees, with sizes from SQLite. */
export function applyFileSet(
  db: Db,
  repo: Repo,
  base: { refsRoot: string | null; files: TreeSummary },
  refDeltas: Map<string, number>,
  declared: { add: string[]; remove: string[] } | null,
): Promise<FileSetResult> {
  return applyFileSetWith(repo, base, refDeltas, declared, (h) => fileSizes(db, h))
}
