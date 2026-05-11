import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { Readable, } from 'node:stream'

// Works with AWS S3, Cloudflare R2, MinIO, or any S3-compatible service.
// For R2: S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
// For MinIO (dev): S3_ENDPOINT=http://minio:9000
const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'auto',
  ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT, }),
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
},)

const bucket = process.env.S3_BUCKET ?? 'underlay'

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
    },),
  )
}

export async function downloadFromS3(key: string,): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, },),
  )
  const stream = res.Body as Readable
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk,),)
  }
  return Buffer.concat(chunks,)
}

export async function headS3Object(key: string,): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, },),)
    return true
  } catch {
    return false
  }
}

export async function getS3ObjectMeta(key: string,): Promise<{ size: number; contentType: string } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, },),)
    if (res.ContentLength == null) return null
    return { size: res.ContentLength, contentType: res.ContentType ?? 'application/octet-stream', }
  } catch {
    return null
  }
}

export async function listS3Objects(prefix: string,): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      },),
    )
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key,)
    }
    continuationToken = res.NextContinuationToken
  } while (continuationToken)

  return keys
}

export async function deleteS3Objects(keys: string[],): Promise<void> {
  if (keys.length === 0) return
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key,) => ({ Key, })), },
    },),
  )
}
