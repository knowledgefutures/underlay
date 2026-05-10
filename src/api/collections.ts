import type { Context } from 'hono'
import { stream } from "hono/streaming";
import { eq, and, ilike, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.server.js";
import { requireAuth, type AuthEnv } from "./auth.server.js";
import { v4 as uuidv4 } from "uuid";
import { pack as tarPack } from "tar-stream";
import { createGzip } from "node:zlib";
import { downloadFromS3 } from "../lib/s3.js";
import { DEFAULT_NAAN, collectionToArkId, getOrMintShoulder, buildArkUrl } from "../lib/ark.js";

// Browse public collections
export async function list(c: Context<AuthEnv>) {
  const q = c.req.query("q");
  const limit = c.req.query("limit");
  const offset = c.req.query("offset");
  const take = Math.min(parseInt(limit ?? "50", 10), 100);
  const skip = parseInt(offset ?? "0", 10);

  const conditions = [eq(schema.collections.public, true)];
  if (q) {
    conditions.push(
      or(
        ilike(schema.collections.name, `%${q}%`),
        ilike(schema.collections.description, `%${q}%`),
      )!,
    );
  }

  const results = await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      description: schema.collections.description,
      ownerSlug: schema.accounts.slug,
      ownerName: schema.accounts.displayName,
      createdAt: schema.collections.createdAt,
      updatedAt: schema.collections.updatedAt,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(and(...conditions))
    .limit(take)
    .offset(skip)
    .orderBy(schema.collections.updatedAt);

  return c.json(results);
}

// Create collection
export async function create(c: Context<AuthEnv>) {
  const owner = c.req.param("owner")!;
  const { slug, name, description, public: isPublic } = await c.req.json<{
    slug: string;
    name: string;
    description?: string;
    public?: boolean;
  }>();

  // Resolve owner account
  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.slug, owner))
    .limit(1);

  if (!account) {
    return c.json({ error: "Account not found", statusCode: 404 }, 404);
  }

  // Check permission: user must own the account or be a member of the org
  if (account.type === "user" && account.id !== c.get("accountId")) {
    return c.json({ error: "Forbidden", statusCode: 403 }, 403);
  }
  if (account.type === "org") {
    const [membership] = await db
      .select()
      .from(schema.orgMemberships)
      .where(
        and(
          eq(schema.orgMemberships.orgId, account.id),
          eq(schema.orgMemberships.userId, c.get("accountId")!),
        ),
      )
      .limit(1);
    if (!membership) {
      return c.json({ error: "Forbidden", statusCode: 403 }, 403);
    }
  }

  // Check for existing collection with same slug under this owner
  const [existing] = await db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .where(
      and(
        eq(schema.collections.accountId, account.id),
        eq(schema.collections.slug, slug),
      ),
    )
    .limit(1);

  if (existing) {
    return c.json({ error: "Collection already exists", statusCode: 409 }, 409);
  }

  const id = uuidv4();
  await db.insert(schema.collections).values({
    id,
    accountId: account.id,
    slug,
    name,
    description: description ?? null,
    public: isPublic ?? false,
  });

  // Auto-mint ARK for the new collection
  try {
    const shoulder = await getOrMintShoulder(account.id);
    const arkId = collectionToArkId(id);
    await db.insert(schema.arkCollections).values({ collectionId: id, arkId, enabled: true });
    const naan = account.arkNaan ?? DEFAULT_NAAN;
    const arkUrl = buildArkUrl(naan, shoulder, arkId);
    return c.json({ id, owner, slug, name, ark: arkUrl }, 201);
  } catch {
    // ARK minting failure is non-fatal
    return c.json({ id, owner, slug, name }, 201);
  }
}

// Get collection
export async function get(c: Context<AuthEnv>) {
  const owner = c.req.param("owner")!;
  const slug = c.req.param("slug")!;

  const [result] = await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      description: schema.collections.description,
      public: schema.collections.public,
      ownerSlug: schema.accounts.slug,
      ownerName: schema.accounts.displayName,
      ownerType: schema.accounts.type,
      createdAt: schema.collections.createdAt,
      updatedAt: schema.collections.updatedAt,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(and(eq(schema.accounts.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1);

  if (!result) {
    return c.json({ error: "Collection not found", statusCode: 404 }, 404);
  }

  if (!result.public && c.get("accountId") !== result.id) {
    // Check if user owns or is member of the owning account
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, owner))
      .limit(1);

    if (!account) {
      return c.json({ error: "Collection not found", statusCode: 404 }, 404);
    }

    let hasAccess = account.id === c.get("accountId");
    if (!hasAccess && account.type === "org") {
      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(
          and(
            eq(schema.orgMemberships.orgId, account.id),
            eq(schema.orgMemberships.userId, c.get("accountId")!),
          ),
        )
        .limit(1);
      hasAccess = !!membership;
    }

    if (!hasAccess) {
      return c.json({ error: "Collection not found", statusCode: 404 }, 404);
    }
  }

  // Get latest version info
  const [latestVersion] = await db
    .select({
      id: schema.versions.id,
      number: schema.versions.number,
      semver: schema.versions.semver,
      recordCount: schema.versions.recordCount,
      fileCount: schema.versions.fileCount,
      totalBytes: schema.versions.totalBytes,
      createdAt: schema.versions.createdAt,
      message: schema.versions.message,
      readme: schema.versions.readme,
    })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, result.id))
    .orderBy(sql`${schema.versions.number} desc`)
    .limit(1);

  // Get per-type record counts for latest version
  let typeCounts: { type: string; count: number }[] = [];
  if (latestVersion) {
    const rows = await db
      .select({
        type: schema.records.type,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.records)
      .where(eq(schema.records.versionId, latestVersion.id))
      .groupBy(schema.records.type);
    typeCounts = rows.map((r) => ({ type: r.type, count: r.count }));
  }

  // Fetch ARK URL if enabled
  let ark: string | null = null;
  try {
    const [arkRow] = await db
      .select({
        arkId: schema.arkCollections.arkId,
        enabled: schema.arkCollections.enabled,
        shoulder: schema.arkShoulders.shoulder,
        ownerNaan: schema.accounts.arkNaan,
      })
      .from(schema.arkCollections)
      .innerJoin(schema.collections, eq(schema.arkCollections.collectionId, schema.collections.id))
      .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
      .innerJoin(schema.arkShoulders, eq(schema.arkShoulders.accountId, schema.accounts.id))
      .where(eq(schema.arkCollections.collectionId, result.id))
      .limit(1);
    if (arkRow?.enabled) {
      ark = buildArkUrl(arkRow.ownerNaan ?? DEFAULT_NAAN, arkRow.shoulder, arkRow.arkId);
    }
  } catch {
    // Non-fatal
  }

  const { id: _vid, ...latestVersionData } = latestVersion ?? { id: undefined };
  return c.json({ ...result, ark, latestVersion: latestVersion ? { ...latestVersionData, typeCounts } : null });
}

// Update collection
export async function update(c: Context<AuthEnv>) {
  const owner = c.req.param("owner")!;
  const slug = c.req.param("slug")!;
  const updates = await c.req.json<{
    name?: string;
    description?: string;
    public?: boolean;
  }>();

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.slug, owner))
    .limit(1);

  if (!account) {
    return c.json({ error: "Not found", statusCode: 404 }, 404);
  }

  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(and(eq(schema.collections.accountId, account.id), eq(schema.collections.slug, slug)))
    .limit(1);

  if (!collection) {
    return c.json({ error: "Not found", statusCode: 404 }, 404);
  }

  await db
    .update(schema.collections)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.collections.id, collection.id));

  return c.json({ ok: true });
}

// Delete collection
export async function remove(c: Context<AuthEnv>) {
  const owner = c.req.param("owner")!;
  const slug = c.req.param("slug")!;

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.slug, owner))
    .limit(1);

  if (!account) {
    return c.json({ error: "Not found", statusCode: 404 }, 404);
  }

  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(and(eq(schema.collections.accountId, account.id), eq(schema.collections.slug, slug)))
    .limit(1);

  if (!collection) {
    return c.json({ error: "Not found", statusCode: 404 }, 404);
  }

  await db.delete(schema.collections).where(eq(schema.collections.id, collection.id));
  return c.json({ ok: true });
}

// List collections for an account
export async function listByOwner(c: Context<AuthEnv>) {
  const owner = c.req.param("owner")!;

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.slug, owner))
    .limit(1);

  if (!account) return c.json([]);

  // Check if the requester owns this account or is an org member
  let hasFullAccess = c.get("accountId") === account.id;
  if (!hasFullAccess && account.type === "org" && c.get("accountId")) {
    const [membership] = await db
      .select()
      .from(schema.orgMemberships)
      .where(
        and(
          eq(schema.orgMemberships.orgId, account.id),
          eq(schema.orgMemberships.userId, c.get("accountId")!),
        ),
      )
      .limit(1);
    hasFullAccess = !!membership;
  }

  const conditions = [eq(schema.collections.accountId, account.id)];
  if (!hasFullAccess) {
    conditions.push(eq(schema.collections.public, true));
  }

  const results = await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      description: schema.collections.description,
      public: schema.collections.public,
      createdAt: schema.collections.createdAt,
      updatedAt: schema.collections.updatedAt,
    })
    .from(schema.collections)
    .where(and(...conditions))
    .orderBy(schema.collections.updatedAt);

  return c.json(results);
}

// Export collection as .tar.gz archive
export async function exportArchive(c: Context<AuthEnv>) {
  const owner = c.req.param("owner")!;
  const slug = c.req.param("slug")!;
  const versionParam = c.req.query("version");

  // Resolve collection
  const [collection] = await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      description: schema.collections.description,
      public: schema.collections.public,
      accountId: schema.collections.accountId,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(and(eq(schema.accounts.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1);

  if (!collection) {
    return c.json({ error: "Collection not found", statusCode: 404 }, 404);
  }

  if (!collection.public && c.get("accountId") !== collection.accountId) {
    return c.json({ error: "Collection not found", statusCode: 404 }, 404);
  }

  // Resolve version (latest if not specified)
  const versionConditions = [eq(schema.versions.collectionId, collection.id)];
  if (versionParam) {
    versionConditions.push(eq(schema.versions.number, parseInt(versionParam, 10)));
  }

  const [version] = await db
    .select()
    .from(schema.versions)
    .where(and(...versionConditions))
    .orderBy(sql`${schema.versions.number} desc`)
    .limit(1);

  if (!version) {
    return c.json({ error: "No versions found", statusCode: 404 }, 404);
  }

  // Fetch records and files for this version
  const records = await db
    .select({
      recordId: schema.records.recordId,
      type: schema.records.type,
      data: schema.records.data,
    })
    .from(schema.records)
    .where(eq(schema.records.versionId, version.id));

  const versionFiles = await db
    .select({
      hash: schema.versionFiles.fileHash,
      size: schema.files.size,
      mimeType: schema.files.mimeType,
      storageKey: schema.files.storageKey,
    })
    .from(schema.versionFiles)
    .innerJoin(schema.files, eq(schema.versionFiles.fileHash, schema.files.hash))
    .where(eq(schema.versionFiles.versionId, version.id));

  // Load schemas for this version
  const versionSchemaEntries = await db
    .select({
      slug: schema.versionSchemas.slug,
      schemaBody: schema.schemas.schema,
    })
    .from(schema.versionSchemas)
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(eq(schema.versionSchemas.versionId, version.id));

  const schemasMap = Object.fromEntries(
    versionSchemaEntries.map((e) => [e.slug, e.schemaBody]),
  );

  // Add manifest.json
  const manifest = {
    collection: { owner, slug, name: collection.name, description: collection.description },
    version: {
      number: version.number,
      semver: version.semver,
      hash: version.hash,
      message: version.message,
      recordCount: version.recordCount,
      fileCount: version.fileCount,
      totalBytes: version.totalBytes,
      createdAt: version.createdAt,
    },
    schemas: schemasMap,
  };

  // Build tar.gz stream
  const pack = tarPack();
  const gzip = createGzip();

  const filename = `${owner}-${slug}-v${version.number}.tar.gz`;

  // Add manifest
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  pack.entry({ name: "manifest.json", size: manifestBuf.length }, manifestBuf);

  // Add records as NDJSON grouped by type
  const recordsByType = new Map<string, typeof records>();
  for (const rec of records) {
    const existing = recordsByType.get(rec.type) ?? [];
    existing.push(rec);
    recordsByType.set(rec.type, existing);
  }

  for (const [type, typeRecords] of recordsByType) {
    const lines = typeRecords.map((r) =>
      JSON.stringify({ id: r.recordId, type: r.type, data: r.data }),
    );
    const buf = Buffer.from(lines.join("\n") + "\n");
    pack.entry({ name: `records/${type}.ndjson`, size: buf.length }, buf);
  }

  // Add files
  for (const file of versionFiles) {
    try {
      const fileBuffer = await downloadFromS3(file.storageKey);
      pack.entry({ name: `files/${file.hash}`, size: fileBuffer.length }, fileBuffer);
    } catch {
      // Skip files that can't be downloaded (shouldn't happen in normal operation)
    }
  }

  pack.finalize();

  // Pipe tar → gzip and collect into a ReadableStream
  const outputStream = pack.pipe(gzip);
  const readableStream = new ReadableStream({
    start(controller) {
      outputStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      outputStream.on("end", () => {
        controller.close();
      });
      outputStream.on("error", (err) => {
        controller.error(err);
      });
    },
  });

  return c.body(readableStream, 200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

