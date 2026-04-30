import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { requireAuth } from "../plugins/auth.js";
import { uploadToS3, downloadFromS3, headS3Object } from "../../lib/s3.js";
import { createHash } from "node:crypto";

/**
 * Check if a file hash is referenced by any public (non-private) record
 * in a non-private field of the latest version of this collection.
 */
async function isFilePubliclyAccessible(
  owner: string,
  slug: string,
  fileHash: string,
  request: any,
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
  if (request.accountId != null && request.accountId === collection.accountId) {
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

export async function fileRoutes(app: FastifyInstance) {
  // Check if file exists
  app.head("/collections/:owner/:slug/files/:hash", async (request, reply) => {
    const { owner, slug, hash } = request.params as { owner: string; slug: string; hash: string };
    const cleanHash = hash.replace("sha256:", "");

    const [file] = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, cleanHash))
      .limit(1);

    if (!file) {
      return reply.status(404).send();
    }

    // Check visibility
    const accessible = await isFilePubliclyAccessible(owner, slug, cleanHash, request);
    if (!accessible) {
      return reply.status(404).send();
    }

    reply.header("Content-Length", file.size);
    reply.header("Content-Type", file.mimeType);
    return reply.status(200).send();
  });

  // Download file
  app.get("/collections/:owner/:slug/files/:hash", async (request, reply) => {
    const { owner, slug, hash } = request.params as { owner: string; slug: string; hash: string };
    const cleanHash = hash.replace("sha256:", "");

    const [file] = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, cleanHash))
      .limit(1);

    if (!file) {
      return reply.status(404).send({ error: "File not found", statusCode: 404 });
    }

    // Check visibility
    const accessible = await isFilePubliclyAccessible(owner, slug, cleanHash, request);
    if (!accessible) {
      return reply.status(404).send({ error: "File not found", statusCode: 404 });
    }

    const buffer = await downloadFromS3(file.storageKey);
    reply.header("Content-Type", file.mimeType);
    reply.header("Content-Length", file.size);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("ETag", `"${cleanHash}"`);
    return reply.send(buffer);
  });

  // Upload file
  app.put(
    "/collections/:owner/:slug/files/:hash",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { owner, slug, hash } = request.params as {
        owner: string;
        slug: string;
        hash: string;
      };
      const cleanHash = hash.replace("sha256:", "");

      // Check if file already exists
      const [existing] = await db
        .select()
        .from(schema.files)
        .where(eq(schema.files.hash, cleanHash))
        .limit(1);

      if (existing) {
        return reply.status(200).send({ hash: cleanHash, status: "exists" });
      }

      // Read the request body as a buffer
      const data = await request.file().catch(() => null);
      if (!data) {
        // Raw binary body — may already be parsed by content type parser
        let buffer: Buffer;
        if (Buffer.isBuffer(request.body)) {
          buffer = request.body;
        } else {
          const chunks: Buffer[] = [];
          for await (const chunk of request.raw) {
            chunks.push(Buffer.from(chunk));
          }
          buffer = Buffer.concat(chunks);
        }

        // Verify hash
        const computedHash = createHash("sha256").update(buffer).digest("hex");
        if (computedHash !== cleanHash) {
          return reply.status(400).send({
            error: "Hash mismatch",
            expected: cleanHash,
            computed: computedHash,
            statusCode: 400,
          });
        }

        const contentType =
          (request.headers["content-type"] as string) ?? "application/octet-stream";
        const storageKey = `files/${cleanHash.slice(0, 2)}/${cleanHash.slice(2, 4)}/${cleanHash}`;

        await uploadToS3(storageKey, buffer, contentType);

        await db.insert(schema.files).values({
          hash: cleanHash,
          size: buffer.length,
          mimeType: contentType,
          storageKey,
        });

        return reply.status(201).send({ hash: cleanHash, size: buffer.length });
      }

      // Multipart upload
      const buffer = await data.toBuffer();
      const computedHash = createHash("sha256").update(buffer).digest("hex");
      if (computedHash !== cleanHash) {
        return reply.status(400).send({
          error: "Hash mismatch",
          expected: cleanHash,
          computed: computedHash,
          statusCode: 400,
        });
      }

      const mimeType = data.mimetype ?? "application/octet-stream";
      const storageKey = `files/${cleanHash.slice(0, 2)}/${cleanHash.slice(2, 4)}/${cleanHash}`;

      await uploadToS3(storageKey, buffer, mimeType);

      await db.insert(schema.files).values({
        hash: cleanHash,
        size: buffer.length,
        mimeType,
        storageKey,
      });

      return reply.status(201).send({ hash: cleanHash, size: buffer.length });
    },
  );
}
