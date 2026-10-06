/**
 * Copy v1 file objects into the deployment's bucket (edge-redesign.md decision
 * 13, revised 2026-10-03; build doc finding 16).
 *
 * v1 keeps a file at `files/aa/bb/<hash>` in its own bucket, which dev and prod
 * share. v2 keeps it at `<repo>/files/<hash>` in the deployment's bucket. After
 * `migrateAll` has copied the `files` table (rows still naming v1 keys), this
 * reads each such file from the v1 bucket, checks it hashes to its name and has
 * its recorded size, writes it at the canonical key and points the row there.
 *
 * Re-runnable: rows already at their canonical key are skipped, and a file whose
 * canonical object already exists with the right size is only repointed. Files
 * that are missing, don't match, or are over `maxBytes` (copied in memory) keep
 * their v1 key and are listed in the report.
 */
import { createHash } from 'node:crypto'

import type { Store } from '@underlay/protocol'
import { dbSchema as schema, type Ports } from '@underlay/server'
import { eq } from 'drizzle-orm'

export interface FileCopyReport {
  copied: number
  /** The canonical object already existed; only the row moved. */
  present: number
  bytes: number
  /** Hashes whose v1 object wasn't in the source bucket. */
  missing: string[]
  /** Hashes whose v1 bytes didn't hash to the name or match the recorded size. */
  mismatched: string[]
  /** Hashes over `maxBytes`, left at their v1 key. */
  tooLarge: string[]
}

export const retryConfig = { attempts: 6, baseMs: 2000 }

export async function copyFiles(
  source: Store,
  ports: Ports,
  opts: {
    concurrency?: number
    maxBytes?: number
    onFile?: (hash: string, done: number, total: number) => void
  } = {},
): Promise<FileCopyReport> {
  const { db, stores } = ports
  const target = stores.fileBytes
  const maxBytes = opts.maxBytes ?? 1024 ** 3
  const report: FileCopyReport = {
    copied: 0,
    present: 0,
    bytes: 0,
    missing: [],
    mismatched: [],
    tooLarge: [],
  }
  const rows = (await db.select().from(schema.files)).filter(
    (f) => f.storageKey !== stores.canonicalFileKey(f.hash),
  )

  const repoint = (hash: string, storageKey: string) =>
    db.update(schema.files).set({ storageKey }).where(eq(schema.files.hash, hash))

  /** A file that throws (a connect timeout to R2) is retried, backing off, before the copy fails. */
  const retrying = async (run: () => Promise<void>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run()
      } catch (err) {
        if (attempt >= retryConfig.attempts) throw err
        console.error(`[files] retry ${attempt}: ${String(err)}`)
        await new Promise((r) => setTimeout(r, retryConfig.baseMs * 2 ** (attempt - 1)))
      }
    }
  }

  let next = 0
  let done = 0
  const worker = async () => {
    while (next < rows.length) {
      const f = rows[next++]!
      await retrying(() => copyOne(f))
      opts.onFile?.(f.hash, ++done, rows.length)
    }
  }
  const copyOne = async (f: (typeof rows)[number]) => {
    const key = stores.canonicalFileKey(f.hash)
    const head = await target.head(key)
    if (head && head.size === f.size) {
      await repoint(f.hash, key)
      report.present++
    } else if (f.size > maxBytes) {
      report.tooLarge.push(f.hash)
    } else {
      const obj = await source.get(f.storageKey)
      if (!obj) {
        report.missing.push(f.hash)
      } else {
        const bytes = await obj.bytes()
        const hash = createHash('sha256').update(bytes).digest('hex')
        if (hash !== f.hash || bytes.byteLength !== f.size) {
          report.mismatched.push(f.hash)
        } else {
          await target.put(key, bytes, { contentType: f.mimeType, ifAbsent: true })
          await repoint(f.hash, key)
          report.copied++
          report.bytes += f.size
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, worker))
  return report
}
