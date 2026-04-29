import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { requireAuth } from "../plugins/auth.js";
import { uploadToS3, downloadFromS3, headS3Object } from "../../lib/s3.js";
import { createHash } from "node:crypto";

export async function fileRoutes(app: FastifyInstance) {
  // Check if file exists
  app.head("/collections/:owner/:slug/files/:hash", async (request, reply) => {
    const { hash } = request.params as { hash: string };
    const cleanHash = hash.replace("sha256:", "");

    const [file] = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, cleanHash))
      .limit(1);

    if (!file) {
      return reply.status(404).send();
    }

    reply.header("Content-Length", file.size);
    reply.header("Content-Type", file.mimeType);
    return reply.status(200).send();
  });

  // Download file
  app.get("/collections/:owner/:slug/files/:hash", async (request, reply) => {
    const { hash } = request.params as { hash: string };
    const cleanHash = hash.replace("sha256:", "");

    const [file] = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.hash, cleanHash))
      .limit(1);

    if (!file) {
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
