import type { FastifyInstance } from "fastify";
import { eq, and, ilike, or, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { requireAuth } from "../plugins/auth.js";
import { v4 as uuidv4 } from "uuid";
import { pack as tarPack } from "tar-stream";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { downloadFromS3 } from "../../lib/s3.js";

export async function corporaRoutes(app: FastifyInstance) {
  // Browse public corpora
  app.get("/corpora", async (request) => {
    const { q, limit, offset } = request.query as {
      q?: string;
      limit?: string;
      offset?: string;
    };
    const take = Math.min(parseInt(limit ?? "50", 10), 100);
    const skip = parseInt(offset ?? "0", 10);

    const conditions = [eq(schema.corpora.public, true)];
    if (q) {
      conditions.push(
        or(
          ilike(schema.corpora.name, `%${q}%`),
          ilike(schema.corpora.description, `%${q}%`),
        )!,
      );
    }

    const results = await db
      .select({
        id: schema.corpora.id,
        slug: schema.corpora.slug,
        name: schema.corpora.name,
        description: schema.corpora.description,
        ownerSlug: schema.accounts.slug,
        ownerName: schema.accounts.displayName,
        createdAt: schema.corpora.createdAt,
        updatedAt: schema.corpora.updatedAt,
      })
      .from(schema.corpora)
      .innerJoin(schema.accounts, eq(schema.corpora.accountId, schema.accounts.id))
      .where(and(...conditions))
      .limit(take)
      .offset(skip)
      .orderBy(schema.corpora.updatedAt);

    return results;
  });

  // Create corpus
  app.post(
    "/accounts/:owner/corpora",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { owner } = request.params as { owner: string };
      const { slug, name, description, public: isPublic } = request.body as {
        slug: string;
        name: string;
        description?: string;
        public?: boolean;
      };

      // Resolve owner account
      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.slug, owner))
        .limit(1);

      if (!account) {
        return reply.status(404).send({ error: "Account not found", statusCode: 404 });
      }

      // Check permission: user must own the account or be a member of the org
      if (account.type === "user" && account.id !== request.accountId) {
        return reply.status(403).send({ error: "Forbidden", statusCode: 403 });
      }
      if (account.type === "org") {
        const [membership] = await db
          .select()
          .from(schema.orgMemberships)
          .where(
            and(
              eq(schema.orgMemberships.orgId, account.id),
              eq(schema.orgMemberships.userId, request.accountId!),
            ),
          )
          .limit(1);
        if (!membership) {
          return reply.status(403).send({ error: "Forbidden", statusCode: 403 });
        }
      }

      const id = uuidv4();
      await db.insert(schema.corpora).values({
        id,
        accountId: account.id,
        slug,
        name,
        description: description ?? null,
        public: isPublic ?? false,
      });

      return reply.status(201).send({ id, owner, slug, name });
    },
  );

  // Get corpus
  app.get("/corpora/:owner/:slug", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };

    const [result] = await db
      .select({
        id: schema.corpora.id,
        slug: schema.corpora.slug,
        name: schema.corpora.name,
        description: schema.corpora.description,
        public: schema.corpora.public,
        ownerSlug: schema.accounts.slug,
        ownerName: schema.accounts.displayName,
        ownerType: schema.accounts.type,
        createdAt: schema.corpora.createdAt,
        updatedAt: schema.corpora.updatedAt,
      })
      .from(schema.corpora)
      .innerJoin(schema.accounts, eq(schema.corpora.accountId, schema.accounts.id))
      .where(and(eq(schema.accounts.slug, owner), eq(schema.corpora.slug, slug)))
      .limit(1);

    if (!result) {
      return reply.status(404).send({ error: "Corpus not found", statusCode: 404 });
    }

    if (!result.public && request.accountId !== result.id) {
      // Check if user owns or is member
      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.slug, owner))
        .limit(1);

      if (!account || account.id !== request.accountId) {
        return reply.status(404).send({ error: "Corpus not found", statusCode: 404 });
      }
    }

    // Get latest version info
    const [latestVersion] = await db
      .select({
        number: schema.versions.number,
        semver: schema.versions.semver,
        recordCount: schema.versions.recordCount,
        fileCount: schema.versions.fileCount,
        totalBytes: schema.versions.totalBytes,
        createdAt: schema.versions.createdAt,
        message: schema.versions.message,
      })
      .from(schema.versions)
      .where(eq(schema.versions.corpusId, result.id))
      .orderBy(sql`${schema.versions.number} desc`)
      .limit(1);

    return { ...result, latestVersion: latestVersion ?? null };
  });

  // Update corpus
  app.patch(
    "/corpora/:owner/:slug",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { owner, slug } = request.params as { owner: string; slug: string };
      const updates = request.body as {
        name?: string;
        description?: string;
        public?: boolean;
      };

      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.slug, owner))
        .limit(1);

      if (!account) {
        return reply.status(404).send({ error: "Not found", statusCode: 404 });
      }

      const [corpus] = await db
        .select()
        .from(schema.corpora)
        .where(and(eq(schema.corpora.accountId, account.id), eq(schema.corpora.slug, slug)))
        .limit(1);

      if (!corpus) {
        return reply.status(404).send({ error: "Not found", statusCode: 404 });
      }

      await db
        .update(schema.corpora)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.corpora.id, corpus.id));

      return { ok: true };
    },
  );

  // Delete corpus
  app.delete(
    "/corpora/:owner/:slug",
    { preHandler: [requireAuth("admin")] },
    async (request, reply) => {
      const { owner, slug } = request.params as { owner: string; slug: string };

      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.slug, owner))
        .limit(1);

      if (!account) {
        return reply.status(404).send({ error: "Not found", statusCode: 404 });
      }

      const [corpus] = await db
        .select()
        .from(schema.corpora)
        .where(and(eq(schema.corpora.accountId, account.id), eq(schema.corpora.slug, slug)))
        .limit(1);

      if (!corpus) {
        return reply.status(404).send({ error: "Not found", statusCode: 404 });
      }

      await db.delete(schema.corpora).where(eq(schema.corpora.id, corpus.id));
      return { ok: true };
    },
  );

  // List corpora for an account
  app.get("/accounts/:owner/corpora", async (request) => {
    const { owner } = request.params as { owner: string };

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, owner))
      .limit(1);

    if (!account) return [];

    const isOwner = request.accountId === account.id;

    const conditions = [eq(schema.corpora.accountId, account.id)];
    if (!isOwner) {
      conditions.push(eq(schema.corpora.public, true));
    }

    return db
      .select({
        id: schema.corpora.id,
        slug: schema.corpora.slug,
        name: schema.corpora.name,
        description: schema.corpora.description,
        public: schema.corpora.public,
        createdAt: schema.corpora.createdAt,
        updatedAt: schema.corpora.updatedAt,
      })
      .from(schema.corpora)
      .where(and(...conditions))
      .orderBy(schema.corpora.updatedAt);
  });

  // Export corpus as .tar.gz archive
  app.get("/corpora/:owner/:slug/export", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };
    const { version: versionParam } = request.query as { version?: string };

    // Resolve corpus
    const [corpus] = await db
      .select({
        id: schema.corpora.id,
        slug: schema.corpora.slug,
        name: schema.corpora.name,
        description: schema.corpora.description,
        public: schema.corpora.public,
        accountId: schema.corpora.accountId,
      })
      .from(schema.corpora)
      .innerJoin(schema.accounts, eq(schema.corpora.accountId, schema.accounts.id))
      .where(and(eq(schema.accounts.slug, owner), eq(schema.corpora.slug, slug)))
      .limit(1);

    if (!corpus) {
      return reply.status(404).send({ error: "Corpus not found", statusCode: 404 });
    }

    if (!corpus.public && request.accountId !== corpus.accountId) {
      return reply.status(404).send({ error: "Corpus not found", statusCode: 404 });
    }

    // Resolve version (latest if not specified)
    const versionConditions = [eq(schema.versions.corpusId, corpus.id)];
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
      return reply.status(404).send({ error: "No versions found", statusCode: 404 });
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

    // Build tar.gz stream
    const pack = tarPack();
    const gzip = createGzip();

    const filename = `${owner}-${slug}-v${version.number}.tar.gz`;
    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);

    // Pipe tar → gzip → response
    const outputStream = pack.pipe(gzip);

    // Add manifest.json
    const manifest = {
      corpus: { owner, slug, name: corpus.name, description: corpus.description },
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
      schema: version.schema,
    };
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
    return reply.send(outputStream);
  });
}
