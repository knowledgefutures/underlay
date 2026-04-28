/**
 * Backs up the Postgres database to S3 using pg_dump.
 *
 * Run manually: npm run tool:backup
 * Scheduled: daily at 3 AM UTC via tools/cron.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { uploadToS3 } from "../src/lib/s3.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://underlay:underlay@localhost:5432/underlay";
const BACKUP_TMP = "./data/backup-tmp";
const S3_PREFIX = process.env.BACKUP_S3_PREFIX ?? "backups/";

async function backup(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  mkdirSync(BACKUP_TMP, { recursive: true });

  // pg_dump to a compressed file
  const dumpPath = join(BACKUP_TMP, `underlay-${timestamp}.sql.gz`);
  execSync(`pg_dump "${DATABASE_URL}" | gzip > "${dumpPath}"`, {
    stdio: "inherit",
  });

  // Upload to S3
  if (!process.env.S3_BUCKET) {
    console.log("[backup] S3_BUCKET not set — skipping upload, dump saved locally:", dumpPath);
    return;
  }

  const s3Key = `${S3_PREFIX}${timestamp}/underlay.sql.gz`;
  const buffer = readFileSync(dumpPath);
  await uploadToS3(s3Key, buffer, "application/gzip");
  console.log(`[backup] Uploaded to S3: ${s3Key}`);

  // Clean up temp file
  unlinkSync(dumpPath);
}

backup().catch((err: unknown) => {
  console.error("[backup] Failed:", err);
  process.exit(1);
});
