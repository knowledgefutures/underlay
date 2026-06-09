/**
 * Backs up the Postgres database to S3 using pg_dump.
 *
 * Run manually: npm run tool:backup
 * Scheduled: daily at 3 AM UTC via tools/cron.ts
 */

import { execSync } from 'node:child_process'
import { createReadStream, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://underlay:underlay@localhost:5432/underlay'
const BACKUP_TMP = './data/backup-tmp'
const S3_PREFIX = '_backups/'

// 32 MB parts — only one part is held in memory at a time during upload.
const PART_SIZE = 32 * 1024 * 1024

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

/**
 * Streams a file from disk to S3 without loading it all into memory.
 * Small files go up in a single PUT; larger files use a multipart upload.
 */
async function streamFileToS3(filePath: string, key: string, contentType: string): Promise<void> {
  const { size } = statSync(filePath)

  if (size <= PART_SIZE) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    )
    return
  }

  const { UploadId: uploadId } = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
  )
  if (!uploadId) throw new Error('CreateMultipartUpload returned no UploadId')

  const file = await open(filePath, 'r')
  try {
    const parts: { ETag: string | undefined; PartNumber: number }[] = []
    const chunk = Buffer.alloc(PART_SIZE)
    let offset = 0
    let partNumber = 1

    while (offset < size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(PART_SIZE, size - offset), offset)
      if (bytesRead === 0) break
      const res = await s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: chunk.subarray(0, bytesRead),
          ContentLength: bytesRead,
        }),
      )
      parts.push({ ETag: res.ETag, PartNumber: partNumber })
      offset += bytesRead
      partNumber += 1
    }

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    )
  } catch (err) {
    await s3
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
      .catch(() => {})
    throw err
  } finally {
    await file.close()
  }
}

async function backup(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

  mkdirSync(BACKUP_TMP, { recursive: true })

  // pg_dump to a compressed file
  const dumpPath = join(BACKUP_TMP, `underlay-${timestamp}.sql.gz`)
  try {
    execSync(`pg_dump "${DATABASE_URL}" | gzip > "${dumpPath}"`, {
      stdio: 'inherit',
    })

    // Upload to S3
    if (!process.env.S3_BUCKET) {
      console.log('[backup] S3_BUCKET not set — skipping upload, dump saved locally:', dumpPath)
      return
    }

    const s3Key = `${S3_PREFIX}${timestamp}/underlay.sql.gz`
    await streamFileToS3(dumpPath, s3Key, 'application/gzip')
    console.log(`[backup] Uploaded to S3: ${s3Key}`)
  } finally {
    // Clean up temp file (kept only when S3_BUCKET is unset)
    if (process.env.S3_BUCKET) {
      try {
        unlinkSync(dumpPath)
      } catch {
        // best-effort cleanup — pg_dump may have failed before creating the file
      }
    }
  }
}

backup().catch((err: unknown) => {
  console.error('[backup] Failed:', err)
  process.exit(1)
})
