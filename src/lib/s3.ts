import type { Readable } from 'node:stream'

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Works with AWS S3, Cloudflare R2, MinIO, or any S3-compatible service.
// For R2: S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
// For MinIO (dev): S3_ENDPOINT=http://minio:9000
const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'auto',
  ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT }),
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
})

// Two buckets:
//  - `bucket` (private): content-addressed record files. Public access is
//    DISABLED on this bucket; reads go through short-lived presigned URLs minted
//    only after the API's access check passes.
//  - `publicBucket`: world-readable assets (avatars, etc.) served directly.
const bucket = process.env.S3_BUCKET ?? 'underlay'
const publicBucket = process.env.S3_PUBLIC_BUCKET ?? 'underlaypublic'

/** Seconds a presigned file URL stays valid. Short — it is minted per request. */
const PRESIGN_TTL_SECONDS = Number(process.env.S3_PRESIGN_TTL_SECONDS ?? '300')

export async function uploadToS3(
  key: string,
  body: Buffer | Readable,
  contentType?: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

/**
 * Mint a short-lived presigned GET URL for a private file object. The download
 * is forced to `attachment` so a file stored with an active content type
 * (e.g. text/html, image/svg+xml) cannot execute as a page in the browser.
 */
export async function getPresignedFileUrl(storageKey: string, filename?: string): Promise<string> {
  const disposition = filename
    ? `attachment; filename="${filename.replace(/["\\]/g, '')}"`
    : 'attachment'
  return getSignedUrl(
    // The presigner and client-s3 ship their own copies of the S3Client type;
    // they are structurally identical but nominally distinct, so cast here.
    s3 as unknown as Parameters<typeof getSignedUrl>[0],
    new GetObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      ResponseContentDisposition: disposition,
    }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  )
}

/** Upload a world-readable asset (avatars, etc.) to the public bucket. */
export async function uploadPublicAsset(
  key: string,
  body: Buffer | Readable,
  contentType?: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: publicBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

export async function listPublicAssets(prefix: string): Promise<string[]> {
  return listObjects(publicBucket, prefix)
}

export async function deletePublicAssets(keys: string[]): Promise<void> {
  return deleteObjects(publicBucket, keys)
}

export async function downloadFromS3(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const stream = res.Body as Readable
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export async function headS3Object(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch {
    return false
  }
}

export async function getS3ObjectMeta(
  key: string,
): Promise<{ size: number; contentType: string } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    if (res.ContentLength == null) return null
    return { size: res.ContentLength, contentType: res.ContentType ?? 'application/octet-stream' }
  } catch {
    return null
  }
}

async function listObjects(targetBucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: targetBucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key)
    }
    continuationToken = res.NextContinuationToken
  } while (continuationToken)

  return keys
}

async function deleteObjects(targetBucket: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: targetBucket,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  )
}

export async function listS3Objects(prefix: string): Promise<string[]> {
  return listObjects(bucket, prefix)
}

export async function deleteS3Objects(keys: string[]): Promise<void> {
  return deleteObjects(bucket, keys)
}
