import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "../db/client.server.js";
import { requireAuth, type AuthEnv } from "./auth.server.js";
import { uploadToS3, headS3Object, getS3ObjectMeta } from "../lib/s3.js";
import { createHash } from "node:crypto";

/**
 * Check if a file hash is referenced by any public (non-private) record
 * in a non-private field of the latest version of this collection.
 */
async function isFilePubliclyAccessible(
  owner: string,
  slug: string,
  fileHash: string,
  accountId: string | undefined,
): Promise<boolean> {
  // Resolve collection
  const [collection] = await db
    .select({
      id: schema.collections.id,
      accountId: schema.collections.accountId,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(and(eq(schema.accounts.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1);

  if (!collection) return false;

  // Owner always has access
  if (accountId != null && accountId === collection.accountId) {
    return true;
  }

  // Get the latest version
  const [latest] = await db
    .select({ id: schema.versions.id })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collection.id))
    .orderBy(sql`${schema.versions.number} desc`)
    .limit(1);

  if (!latest) return false;

  // Check if file is associated with this version at all
  const [vf] = await db
    .select({ fileHash: schema.versionFiles.fileHash })
    .from(schema.versionFiles)
    .where(
      and(eq(schema.versionFiles.versionId, latest.id), eq(schema.versionFiles.fileHash, fileHash)),
    )
    .limit(1);

  if (!vf) return false;

  // Load version schemas to determine private types and fields
  const schemaEntries = await db
    .select({
      slug: schema.versionSchemas.slug,
      schemaBody: schema.schemas.schema,
    })
    .from(schema.versionSchemas)
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(eq(schema.versionSchemas.versionId, latest.id));

  const privateTypes = new Set<string>();
  const typeSchemaMap = new Map<string, Record<string, any>>();
  for (const entry of schemaEntries) {
    const body = entry.schemaBody as Record<string, any>;
    typeSchemaMap.set(entry.slug, body);
    if (body?.private === true) privateTypes.add(entry.slug);
  }

  // Find public records that reference this file hash
  // A record references a file if its data JSON contains the hash string
  const records = await db
    .select({ type: schema.records.type, data: schema.records.data })
    .from(schema.records)
    .where(
      and(
        eq(schema.records.versionId, latest.id),
        eq(schema.records.private, false),
        sql`${schema.records.data}::text LIKE ${"%" + fileHash + "%"}`,
      ),
    )
    .limit(10);

  // Check if any matching record is a public type with the file in a public field
  for (const rec of records) {
    if (privateTypes.has(rec.type)) continue;

    // Get private fields for this type
    const typeSchema = typeSchemaMap.get(rec.type);
    const typeProps = typeSchema?.properties as Record<string, any> | undefined;
    if (!typeProps) return true; // no schema constraints, allow

    const privateFields = new Set<string>();
    for (const [fieldName, fieldDef] of Object.entries(typeProps)) {
      if ((fieldDef as any)?.private === true) privateFields.add(fieldName);
    }

    // Check if the file reference is in a public field
    const data = rec.data as Record<string, any>;
    for (const [key, val] of Object.entries(data)) {
      if (privateFields.has(key)) continue;
      if (
        val &&
        typeof val === "object" &&
        "$file" in val &&
        (val as { $file: string }).$file === `sha256:${fileHash}`
      ) {
        return true; // found in a public field of a public record
      }
    }
  }

  return false;
}

const app = new Hono<AuthEnv>();

// Check if file exists
app.on("HEAD", "/collections/:owner/:slug/files/:hash", async (c) => {
  const owner = c.req.param("owner");
  const slug = c.req.param("slug");
  const hash = c.req.param("hash");
  const cleanHash = hash.replace("sha256:", "");

  const [file] = await db
    .select()
    .from(schema.files)
    .where(eq(schema.files.hash, cleanHash))
    .limit(1);

  if (!file) {
    return c.body(null, 404);
  }

  // Check visibility
  const accessible = await isFilePubliclyAccessible(owner, slug, cleanHash, c.get("accountId"));
  if (!accessible) {
    return c.body(null, 404);
  }

  c.header("Content-Length", String(file.size));
  c.header("Content-Type", file.mimeType);
  return c.body(null, 200);
});

// Download file
app.get("/collections/:owner/:slug/files/:hash", async (c) => {
  const owner = c.req.param("owner");
  const slug = c.req.param("slug");
  const hash = c.req.param("hash");
  const cleanHash = hash.replace("sha256:", "");

  const [file] = await db
    .select()
    .from(schema.files)
    .where(eq(schema.files.hash, cleanHash))
    .limit(1);

  if (!file) {
    return c.json({ error: "File not found", statusCode: 404 }, 404);
  }

  // Check visibility
  const accessible = await isFilePubliclyAccessible(owner, slug, cleanHash, c.get("accountId"));
  if (!accessible) {
    return c.json({ error: "File not found", statusCode: 404 }, 404);
  }

  // Redirect to CDN
  const cdnUrl = `https://assets.underlay.org/files/${cleanHash.slice(0, 2)}/${cleanHash.slice(2, 4)}/${cleanHash}`;
  return c.redirect(cdnUrl);
});

// Upload file
app.put(
  "/collections/:owner/:slug/files/:hash",
  requireAuth("write"),
  async (c) => {
    const owner = c.req.param("owner");
    const slug = c.req.param("slug");
    const hash = c.req.param("hash");
    const cleanHash = hash.replace("sha256:", "");

    // Check if file already exists in DB
    const [existing] = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, cleanHash))
      .limit(1);

    if (existing) {
      return c.json({ hash: cleanHash, status: "exists" }, 200);
    }

    // Check if file exists in S3 but not in local DB (shared bucket scenario)
    const s3Key = `files/${cleanHash.slice(0, 2)}/${cleanHash.slice(2, 4)}/${cleanHash}`;
    const s3Meta = await getS3ObjectMeta(s3Key);
    if (s3Meta !== null) {
      await db.insert(schema.files).values({
        hash: cleanHash,
        size: s3Meta.size,
        mimeType: s3Meta.contentType,
        storageKey: s3Key,
      }).onConflictDoNothing();
      return c.json({ hash: cleanHash, status: "exists" }, 200);
    }

    // Try multipart first
    const contentType = c.req.header("content-type") ?? "application/octet-stream";

    let buffer: Buffer;
    let mimeType: string;

    if (contentType.startsWith("multipart/")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (file instanceof File) {
        const ab = await file.arrayBuffer();
        buffer = Buffer.from(ab);
        mimeType = file.type || "application/octet-stream";
      } else {
        return c.json({ error: "No file in multipart body", statusCode: 400 }, 400);
      }
    } else {
      // Raw binary body
      const ab = await c.req.arrayBuffer();
      buffer = Buffer.from(ab);
      mimeType = contentType;
    }

    // Verify hash
    const computedHash = createHash("sha256").update(buffer).digest("hex");
    if (computedHash !== cleanHash) {
      return c.json({
        error: "Hash mismatch",
        expected: cleanHash,
        computed: computedHash,
        statusCode: 400,
      }, 400);
    }

    const storageKey = `files/${cleanHash.slice(0, 2)}/${cleanHash.slice(2, 4)}/${cleanHash}`;

    await uploadToS3(storageKey, buffer, mimeType);

    await db.insert(schema.files).values({
      hash: cleanHash,
      size: buffer.length,
      mimeType,
      storageKey,
    });

    return c.json({ hash: cleanHash, size: buffer.length }, 201);
  },
);

export const fileRoutes = app;
