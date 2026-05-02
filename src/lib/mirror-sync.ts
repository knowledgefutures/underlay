/**
 * Mirror sync logic.
 *
 * Pulls all public collections, versions, records, and files from an upstream
 * Underlay server. Designed to be called by cron or triggered manually.
 */

import { db, schema } from "../db/index.js";
import { eq, and, sql } from "drizzle-orm";
import { uploadToS3, headS3Object } from "./s3.js";
import { createHash } from "node:crypto";
import { getMirrorConfig } from "./mirror-config.js";

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  collections: { synced: number; created: number; failed: number };
  versions: { pulled: number };
  files: { downloaded: number; skipped: number };
  errors: string[];
}

/** Ensure a system account exists for mirrored content */
async function ensureMirrorAccount(ownerSlug: string): Promise<string> {
  const [existing] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.slug, ownerSlug))
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.accounts)
    .values({
      slug: ownerSlug,
      type: "org",
      displayName: ownerSlug,
      email: null,
      passwordHash: null,
    })
    .returning({ id: schema.accounts.id });

  return created!.id;
}

/** Ensure a schema record exists (content-addressed) */
async function ensureSchema(schemaBody: unknown): Promise<string> {
  const schemaHash = createHash("sha256")
    .update(JSON.stringify(schemaBody))
    .digest("hex");

  const [existing] = await db
    .select({ id: schema.schemas.id })
    .from(schema.schemas)
    .where(eq(schema.schemas.schemaHash, schemaHash))
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.schemas)
    .values({ schema: schemaBody as any, schemaHash })
    .returning({ id: schema.schemas.id });

  return created!.id;
}

/** Sleep for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch JSON from the upstream server with retry on 429 */
async function fetchUpstream<T>(upstream: string, path: string): Promise<T> {
  const config = getMirrorConfig();
  const url = `${upstream.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
      const waitSec = Math.min(retryAfter + 2, 120);
      console.log(`[mirror-sync] Rate limited, waiting ${waitSec}s before retry (attempt ${attempt + 1}/5)`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Upstream ${url} returned ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  throw new Error(`Upstream ${url} rate limited after 5 retries`);
}

/** Download a file from upstream by hash */
async function downloadUpstreamFile(
  upstream: string,
  owner: string,
  collSlug: string,
  fileHash: string,
): Promise<Buffer> {
  const config = getMirrorConfig();
  const url = `${upstream.replace(/\/$/, "")}/api/collections/${owner}/${collSlug}/files/${fileHash}`;
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
      const waitSec = Math.min(retryAfter + 2, 120);
      console.log(`[mirror-sync] Rate limited on file download, waiting ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!res.ok) {
      throw new Error(`File download failed: ${url} → ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  throw new Error(`File download rate limited after 5 retries: ${url}`);
}

interface UpstreamCollection {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerSlug: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

interface UpstreamVersion {
  number: number;
  semver: string;
  hash: string;
  message: string | null;
  appId: string | null;
  actorId: string | null;
  recordCount: number;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

interface UpstreamManifest {
  version: number;
  semver: string;
  hash: string;
  schemas: Record<string, string>;
  records: { id: string; type: string }[];
  files: string[];
}

interface UpstreamRecordsResponse {
  records: { id: string; type: string; data: unknown }[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null; total: number };
}

/**
 * Run a full mirror sync from the configured upstream.
 */
export async function runMirrorSync(): Promise<SyncResult> {
  const config = getMirrorConfig();
  if (!config.enabled || !config.upstream) {
    throw new Error("Mirror mode is not configured");
  }

  const result: SyncResult = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    collections: { synced: 0, created: 0, failed: 0 },
    versions: { pulled: 0 },
    files: { downloaded: 0, skipped: 0 },
    errors: [],
  };

  const upstream = config.upstream;

  // 1. Fetch all public collections from upstream
  let upstreamCollections: UpstreamCollection[];
  try {
    upstreamCollections = await fetchUpstream<UpstreamCollection[]>(
      upstream,
      "/api/collections?limit=100",
    );
  } catch (err) {
    result.errors.push(`Failed to fetch collections: ${err}`);
    result.finishedAt = new Date().toISOString();
    return result;
  }

  // 2. For each upstream collection, sync it locally
  for (const uc of upstreamCollections) {
    try {
      await syncCollection(upstream, uc, result);
      result.collections.synced++;
    } catch (err) {
      result.collections.failed++;
      result.errors.push(`${uc.ownerSlug}/${uc.slug}: ${err}`);
    }
  }

  result.finishedAt = new Date().toISOString();
  return result;
}

async function syncCollection(
  upstream: string,
  uc: UpstreamCollection,
  result: SyncResult,
): Promise<void> {
  // Ensure the owner account exists locally
  const accountId = await ensureMirrorAccount(uc.ownerSlug);

  // Check if collection exists locally
  const [localColl] = await db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(
      and(
        eq(schema.accounts.slug, uc.ownerSlug),
        eq(schema.collections.slug, uc.slug),
      ),
    )
    .limit(1);

  let collectionId: string;

  if (!localColl) {
    // Create the collection locally
    const [created] = await db
      .insert(schema.collections)
      .values({
        accountId,
        slug: uc.slug,
        name: uc.name,
        description: uc.description,
        public: true,
      })
      .returning({ id: schema.collections.id });
    collectionId = created!.id;
    result.collections.created++;
  } else {
    collectionId = localColl.id;
  }

  // Get the latest local version number
  const [latestLocal] = await db
    .select({ number: schema.versions.number })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collectionId))
    .orderBy(sql`${schema.versions.number} desc`)
    .limit(1);

  const localVersionNum = latestLocal?.number ?? 0;

  // Fetch upstream versions we don't have
  const upstreamVersions = await fetchUpstream<UpstreamVersion[]>(
    upstream,
    `/api/collections/${uc.ownerSlug}/${uc.slug}/versions?limit=100`,
  );

  // Sort ascending to apply in order
  const newVersions = upstreamVersions
    .filter((v) => v.number > localVersionNum)
    .sort((a, b) => a.number - b.number);

  if (newVersions.length === 0) return;

  // Pull each new version
  for (const uv of newVersions) {
    await pullVersion(upstream, uc, collectionId, uv, result);
    result.versions.pulled++;
  }
}

async function pullVersion(
  upstream: string,
  uc: UpstreamCollection,
  collectionId: string,
  uv: UpstreamVersion,
  result: SyncResult,
): Promise<void> {
  // Get the version manifest (schemas + file list)
  const manifest = await fetchUpstream<UpstreamManifest>(
    upstream,
    `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.number}/manifest`,
  );

  // Pull all records (paginated)
  const allRecords: { id: string; type: string; data: unknown }[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const recordsPath: string = cursor
      ? `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.number}/records?limit=1000&after=${cursor}`
      : `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.number}/records?limit=1000`;

    const page: UpstreamRecordsResponse = await fetchUpstream<UpstreamRecordsResponse>(upstream, recordsPath);
    allRecords.push(...page.records);
    hasMore = page.pagination.hasMore;
    cursor = page.pagination.nextCursor;
  }

  // Pull files
  for (const fileHash of manifest.files) {
    const storageKey = `files/${fileHash.slice(0, 2)}/${fileHash.slice(2, 4)}/${fileHash}`;

    // Check if file already exists in our S3
    const exists = await headS3Object(storageKey);
    if (exists) {
      // Also ensure it's in the files table
      const [existingFile] = await db
        .select({ hash: schema.files.hash })
        .from(schema.files)
        .where(eq(schema.files.hash, fileHash))
        .limit(1);

      if (existingFile) {
        result.files.skipped++;
        continue;
      }
    }

    // Download from upstream
    try {
      const buffer = await downloadUpstreamFile(upstream, uc.ownerSlug, uc.slug, fileHash);

      // Verify hash
      const computedHash = createHash("sha256").update(buffer).digest("hex");
      if (computedHash !== fileHash) {
        result.errors.push(
          `File hash mismatch for ${fileHash}: computed ${computedHash}`,
        );
        continue;
      }

      // Upload to our S3
      await uploadToS3(storageKey, buffer);

      // Upsert into files table
      await db
        .insert(schema.files)
        .values({
          hash: fileHash,
          size: buffer.length,
          mimeType: "application/octet-stream",
          storageKey,
        })
        .onConflictDoNothing();

      result.files.downloaded++;
    } catch (err) {
      result.errors.push(`File ${fileHash}: ${err}`);
    }
  }

  // Get or create schema records for this version
  // We need to fetch the actual schema bodies from the upstream version
  const upstreamSchemas = await fetchUpstream<Record<string, unknown>>(
    upstream,
    `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.number}/records?limit=0`,
  ).catch(() => null);

  // Fetch schema bodies from the manifest endpoint — the manifest only has hashes.
  // We'll reconstruct from the records' types + the schema lookup endpoint.
  // Actually, let's fetch schemas from the upstream schemas API if available,
  // or infer from the version data. For now, we'll pull full version detail.
  const versionDetail = await fetchUpstream<{
    number: number;
    semver: string;
    hash: string;
    schemas: Record<string, unknown>;
    readme?: string;
  }>(upstream, `/api/collections/${uc.ownerSlug}/${uc.slug}/versions/${uv.number}`).catch(
    () => null,
  );

  // Create the version record
  const [newVersion] = await db
    .insert(schema.versions)
    .values({
      collectionId,
      number: uv.number,
      semver: uv.semver,
      hash: uv.hash,
      message: uv.message,
      appId: uv.appId,
      actorId: uv.actorId,
      recordCount: allRecords.length,
      fileCount: manifest.files.length,
      totalBytes: uv.totalBytes,
    })
    .returning({ id: schema.versions.id });

  const versionId = newVersion!.id;

  // Insert schemas
  if (versionDetail?.schemas) {
    for (const [slug, schemaBody] of Object.entries(versionDetail.schemas)) {
      const schemaId = await ensureSchema(schemaBody);
      await db.insert(schema.versionSchemas).values({ versionId, slug, schemaId });
    }
  }

  // Insert records in batches
  const BATCH_SIZE = 500;
  for (let i = 0; i < allRecords.length; i += BATCH_SIZE) {
    const batch = allRecords.slice(i, i + BATCH_SIZE);
    await db.insert(schema.records).values(
      batch.map((r) => ({
        versionId,
        recordId: r.id,
        type: r.type,
        data: r.data as any,
        private: false,
      })),
    );
  }

  // Link files to version
  if (manifest.files.length > 0) {
    await db.insert(schema.versionFiles).values(
      manifest.files.map((hash) => ({ versionId, fileHash: hash })),
    );
  }
}

/**
 * Test connectivity to an upstream server.
 */
export async function testUpstreamConnection(upstream: string): Promise<{
  ok: boolean;
  version?: string;
  collectionCount?: number;
  error?: string;
}> {
  try {
    const health = await fetchUpstream<{ status: string; timestamp: string }>(
      upstream,
      "/api/health",
    );

    if (health.status !== "ok") {
      return { ok: false, error: "Upstream health check failed" };
    }

    const collections = await fetchUpstream<unknown[]>(
      upstream,
      "/api/collections?limit=1",
    );

    // Get full count by fetching with limit=100
    const allColls = await fetchUpstream<unknown[]>(
      upstream,
      "/api/collections?limit=100",
    );

    return {
      ok: true,
      version: "unknown",
      collectionCount: allColls.length,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Get the current sync status for all mirrored collections.
 */
export async function getMirrorStatus(): Promise<{
  upstream: string;
  nodeName: string;
  syncSchedule: string;
  collections: {
    ownerSlug: string;
    slug: string;
    name: string;
    localVersion: number;
    updatedAt: string;
  }[];
  lastSyncAt: string | null;
}> {
  const config = getMirrorConfig();

  const collections = await db
    .select({
      ownerSlug: schema.accounts.slug,
      slug: schema.collections.slug,
      name: schema.collections.name,
      updatedAt: schema.collections.updatedAt,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(eq(schema.collections.public, true));

  // Get latest version for each collection
  const collsWithVersions = await Promise.all(
    collections.map(async (c) => {
      const [latest] = await db
        .select({ number: schema.versions.number })
        .from(schema.versions)
        .innerJoin(
          schema.collections,
          eq(schema.versions.collectionId, schema.collections.id),
        )
        .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
        .where(
          and(
            eq(schema.accounts.slug, c.ownerSlug),
            eq(schema.collections.slug, c.slug),
          ),
        )
        .orderBy(sql`${schema.versions.number} desc`)
        .limit(1);

      return {
        ownerSlug: c.ownerSlug,
        slug: c.slug,
        name: c.name,
        localVersion: latest?.number ?? 0,
        updatedAt: c.updatedAt.toISOString(),
      };
    }),
  );

  return {
    upstream: config.upstream,
    nodeName: config.nodeName,
    syncSchedule: config.syncSchedule,
    collections: collsWithVersions,
    lastSyncAt: null, // TODO: track this in a simple kv table or file
  };
}
