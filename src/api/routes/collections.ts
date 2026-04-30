import type { FastifyInstance } from "fastify";
import { eq, and, ilike, or, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { getSchemasAsOf } from "../../db/queries.js";
import { requireAuth } from "../plugins/auth.js";
import { v4 as uuidv4 } from "uuid";
import { pack as tarPack } from "tar-stream";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { downloadFromS3 } from "../../lib/s3.js";

export async function collectionsRoutes(app: FastifyInstance) {
  // Browse public collections
  app.get("/collections", async (request) => {
    const { q, limit, offset } = request.query as {
      q?: string;
      limit?: string;
      offset?: string;
    };
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

    return results;
  });

  // Create collection
  app.post(
    "/accounts/:owner/collections",
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
        return reply.status(409).send({ error: "Collection already exists", statusCode: 409 });
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

      return reply.status(201).send({ id, owner, slug, name });
    },
  );

  // Get collection
  app.get("/collections/:owner/:slug", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };

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
      return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
    }

    if (!result.public && request.accountId !== result.id) {
      // Check if user owns or is member of the owning account
      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.slug, owner))
        .limit(1);

      if (!account) {
        return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
      }

      let hasAccess = account.id === request.accountId;
      if (!hasAccess && account.type === "org") {
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
        hasAccess = !!membership;
      }

      if (!hasAccess) {
        return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
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

    // Get per-type record counts and schemas for latest version
    let typeCounts: { type: string; count: number }[] = [];
    let latestSchemas: { slug: string; schema: unknown; schemaHash: string; sourceSchemaId: string | null }[] = [];
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
      latestSchemas = [...(await getSchemasAsOf(result.id, latestVersion.number)).values()];
    }

    const { id: _vid, ...latestVersionData } = latestVersion ?? { id: undefined };
    return {
      ...result,
      latestVersion: latestVersion
        ? { ...latestVersionData, typeCounts, schemas: latestSchemas }
        : null,
    };
  });

  // Update collection
  app.patch(
    "/collections/:owner/:slug",
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

      const [collection] = await db
        .select()
        .from(schema.collections)
        .where(and(eq(schema.collections.accountId, account.id), eq(schema.collections.slug, slug)))
        .limit(1);

      if (!collection) {
        return reply.status(404).send({ error: "Not found", statusCode: 404 });
      }

      await db
        .update(schema.collections)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.collections.id, collection.id));

      return { ok: true };
    },
  );

  // Delete collection
  app.delete(
    "/collections/:owner/:slug",
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

      const [collection] = await db
        .select()
        .from(schema.collections)
        .where(and(eq(schema.collections.accountId, account.id), eq(schema.collections.slug, slug)))
        .limit(1);

      if (!collection) {
        return reply.status(404).send({ error: "Not found", statusCode: 404 });
      }

      await db.delete(schema.collections).where(eq(schema.collections.id, collection.id));
      return { ok: true };
    },
  );

  // List collections for an account
  app.get("/accounts/:owner/collections", async (request) => {
    const { owner } = request.params as { owner: string };

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, owner))
      .limit(1);

    if (!account) return [];

    // Check if the requester owns this account or is an org member
    let hasFullAccess = request.accountId === account.id;
    if (!hasFullAccess && account.type === "org" && request.accountId) {
      const [membership] = await db
        .select()
        .from(schema.orgMemberships)
        .where(
          and(
            eq(schema.orgMemberships.orgId, account.id),
            eq(schema.orgMemberships.userId, request.accountId),
          ),
        )
        .limit(1);
      hasFullAccess = !!membership;
    }

    const conditions = [eq(schema.collections.accountId, account.id)];
    if (!hasFullAccess) {
      conditions.push(eq(schema.collections.public, true));
    }

    return db
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
  });

  // Export collection as .tar.gz archive
  app.get("/collections/:owner/:slug/export", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };
    const { version: versionParam } = request.query as { version?: string };

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
      return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
    }

    if (!collection.public && request.accountId !== collection.accountId) {
      return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
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
      return reply.status(404).send({ error: "No versions found", statusCode: 404 });
    }

    // Fetch schemas for this version
    const exportSchemas = [...(await getSchemasAsOf(collection.id, version.number)).values()];

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
      schemas: exportSchemas,
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
