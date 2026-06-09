/**
 * Prunes old database backups from S3 under the `_backups/` prefix.
 *
 * Retention policy:
 *   - Keep the most recent KEEP_DAILY backups (default 14).
 *   - Additionally keep the newest backup of each week for the last
 *     KEEP_WEEKLY weeks (default 8).
 *   - Delete everything else.
 *
 * Run manually:  npm run tool:pruneBackups [-- --dry-run] [-- --keep-daily=N --keep-weekly=M]
 * Env overrides: PRUNE_KEEP_DAILY, PRUNE_KEEP_WEEKLY
 * Scheduled:     weekly via tools/cron.ts
 */

import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

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

function intOption(flag: string, envVar: string, fallback: number): number {
  const args = process.argv.slice(2)
  const fromFlag = args.find((a) => a.startsWith(`${flag}=`))?.split('=')[1]
  const raw = fromFlag ?? process.env[envVar]
  if (raw == null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${fromFlag != null ? flag : envVar}: ${raw}`)
  }
  return parsed
}

type Backup = { key: string; date: Date }

/**
 * Backup keys look like `_backups/2026-06-09T03-00-00-000Z/underlay.sql.gz` —
 * an ISO timestamp with `:` and `.` replaced by `-` (see tools/backupDb.ts).
 */
function parseBackupDate(key: string, lastModified: Date | undefined): Date | undefined {
  const match = /^_backups\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\//.exec(key)
  if (match) {
    const [, day, hh, mm, ss, ms] = match
    const date = new Date(`${day}T${hh}:${mm}:${ss}.${ms}Z`)
    if (!Number.isNaN(date.getTime())) return date
  }
  return lastModified
}

async function listBackups(): Promise<Backup[]> {
  const backups: Backup[] = []
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
      if (!obj.Key) continue
      const date = parseBackupDate(obj.Key, obj.LastModified)
      if (!date) {
        console.log(`[prune] Skipping (no parseable date): ${obj.Key}`)
        continue
      }
      backups.push({ key: obj.Key, date })
    }
    continuationToken = res.NextContinuationToken
  } while (continuationToken)

  // Newest first
  return backups.sort((a, b) => b.date.getTime() - a.date.getTime())
}

/** UTC Monday 00:00 of the week containing `date`, as an ISO day string. */
function weekStart(date: Date): string {
  const d = new Date(date)
  const dayOfWeek = (d.getUTCDay() + 6) % 7 // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayOfWeek)
  return d.toISOString().slice(0, 10)
}

async function deleteKeys(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    )
  }
}

async function prune(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const keepDaily = intOption('--keep-daily', 'PRUNE_KEEP_DAILY', 14)
  const keepWeekly = intOption('--keep-weekly', 'PRUNE_KEEP_WEEKLY', 8)

  console.log(
    `[prune] Policy: keep ${keepDaily} most recent + 1/week for ${keepWeekly} weeks${dryRun ? ' (dry run)' : ''}`,
  )

  const backups = await listBackups()
  console.log(`[prune] Found ${backups.length} backups under s3://${bucket}/${S3_PREFIX}`)

  const keep = new Map<string, string>() // key -> reason

  // Most recent N
  for (const backup of backups.slice(0, keepDaily)) {
    keep.set(backup.key, 'daily')
  }

  // Newest backup per week, for the most recent M distinct weeks
  const newestPerWeek = new Map<string, Backup>()
  for (const backup of backups) {
    const week = weekStart(backup.date)
    if (!newestPerWeek.has(week)) newestPerWeek.set(week, backup) // backups are sorted newest first
  }
  const recentWeeks = [...newestPerWeek.keys()].sort().reverse().slice(0, keepWeekly)
  for (const week of recentWeeks) {
    const backup = newestPerWeek.get(week)
    if (backup && !keep.has(backup.key)) keep.set(backup.key, `weekly (${week})`)
  }

  const toDelete = backups.filter((b) => !keep.has(b.key))

  for (const backup of backups) {
    const reason = keep.get(backup.key)
    if (reason) {
      console.log(`[prune] Keep:   ${backup.key} (${reason})`)
    } else {
      console.log(`[prune] ${dryRun ? 'Would delete' : 'Delete'}: ${backup.key}`)
    }
  }

  if (toDelete.length === 0) {
    console.log('[prune] Nothing to delete.')
    return
  }

  if (dryRun) {
    console.log(`[prune] Dry run — would delete ${toDelete.length}, keep ${keep.size}.`)
    return
  }

  await deleteKeys(toDelete.map((b) => b.key))
  console.log(`[prune] Deleted ${toDelete.length}, kept ${keep.size}.`)
}

prune().catch((err: unknown) => {
  console.error('[prune] Failed:', err)
  process.exit(1)
})
