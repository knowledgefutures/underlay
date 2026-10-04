/**
 * File sets on the platform: the protocol package's file-set bookkeeping
 * (src/repo/file-sets.ts), with file sizes from the files table.
 */
import {
  applyFileSet as applyFileSetWith,
  type FileSetResult,
  type Repo,
  type TreeSummary,
} from '@underlay/protocol'
import { inArray } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export {
  declaredFiles,
  FileRefDelta,
  type FileSetResult,
  MissingFilesError,
  type SetName,
} from '@underlay/protocol'

/** File sizes for hashes, from the files table (chunked for D1's bound-parameter limit). */
export async function fileSizes(db: Db, hashes: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < hashes.length; i += 90) {
    const rows = await db
      .select({ hash: schema.files.hash, size: schema.files.size })
      .from(schema.files)
      .where(inArray(schema.files.hash, hashes.slice(i, i + 90)))
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
