/**
 * Restores the Postgres database from a backup in S3.
 *
 * List available backups:  npm run tool:restore
 * Restore a backup:        npm run tool:restore -- <s3-key> --yes
 *
 * Backups are plain-format pg_dump output gzipped by tools/backupDb.ts, so the
 * restore pipes `gunzip -c | psql` into DATABASE_URL. This is DESTRUCTIVE-ish:
 * it replays the dump into the target database as-is, so the target should be
 * empty (e.g. a freshly created database). The `--yes` flag is required.
 */

import { execSync } from 'node:child_process'
import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://underlay:underlay@localhost:5432/underlay'
const BACKUP_TMP = './data/backup-tmp'
const S3_PREFIX = '_backups/'

// Same client config as src/lib/s3.ts (not exported there, so duplicated here).
const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'auto',
  ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT }),
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
})

const bucket = process.env.S3_BUCKET ?? 'underlay'

type BackupObject = { key: string; size: number; lastModified: Date | undefined }

async function listBackups(): Promise<BackupObject[]> {
  const objects: BackupObject[] = []
  let continuationToken: string | undefined

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: S3_PREFIX,
        ContinuationToken: continuationToken,
      }),
    )
    for (const obj of res.Contents ?? []) {
      if (obj.Key) {
        objects.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified })
      }
    }
    continuationToken = res.NextContinuationToken
  } while (continuationToken)

  return objects.sort((a, b) => b.key.localeCompare(a.key))
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function printUsage(): void {
  console.log('')
  console.log('Usage: npm run tool:restore -- <s3-key> --yes')
  console.log(
    '  e.g. npm run tool:restore -- _backups/2026-06-09T03-00-00-000Z/underlay.sql.gz --yes',
  )
  console.log('')
  console.log('The --yes flag is required because restore writes into DATABASE_URL.')
}

async function downloadToFile(key: string, destPath: string): Promise<void> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!res.Body) throw new Error(`Empty response body for s3://${bucket}/${key}`)
  await pipeline(res.Body as Readable, createWriteStream(destPath))
}

async function restore(): Promise<void> {
  const args = process.argv.slice(2)
  const yes = args.includes('--yes')
  const key = args.find((a) => !a.startsWith('--'))

  if (!key) {
    console.log(`[restore] Available backups in s3://${bucket}/${S3_PREFIX}:`)
    const backups = await listBackups()
    if (backups.length === 0) {
      console.log('[restore]   (none found)')
    }
    for (const b of backups) {
      const date = b.lastModified?.toISOString() ?? 'unknown date'
      console.log(`[restore]   ${b.key}  ${formatSize(b.size)}  ${date}`)
    }
    printUsage()
    return
  }

  const url = new URL(DATABASE_URL)
  const target = `${url.hostname}:${url.port || '5432'}${url.pathname}`
  console.log(`[restore] Backup:  s3://${bucket}/${key}`)
  console.log(`[restore] Target:  ${target} (from DATABASE_URL)`)

  if (!yes) {
    console.log('[restore] Refusing to restore without --yes. No changes were made.')
    printUsage()
    process.exit(1)
  }

  mkdirSync(BACKUP_TMP, { recursive: true })
  const dumpPath = join(BACKUP_TMP, `restore-${Date.now()}.sql.gz`)

  try {
    console.log(`[restore] Downloading to ${dumpPath}...`)
    await downloadToFile(key, dumpPath)

    console.log('[restore] Restoring via psql...')
    execSync(`gunzip -c "${dumpPath}" | psql "${DATABASE_URL}"`, {
      stdio: 'inherit',
    })
    console.log('[restore] Done.')
  } finally {
    try {
      unlinkSync(dumpPath)
    } catch {
      // best-effort cleanup — download may have failed before creating the file
    }
  }
}

restore().catch((err: unknown) => {
  console.error('[restore] Failed:', err)
  process.exit(1)
})
