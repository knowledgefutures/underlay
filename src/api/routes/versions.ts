import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { alias as aliasedTable } from "drizzle-orm/pg-core";
import { db, schema } from "../../db/index.js";
import { requireAuth } from "../plugins/auth.js";
import { pushVersion } from "../lib/pushVersion.js";

export async function versionRoutes(app: FastifyInstance) {
  // Lazily backfill totalBytes for versions that were created before we tracked it
  async function backfillTotalBytes(version: { id: number; totalBytes: number; recordCount: number }) {
    if (version.totalBytes > 0 || version.recordCount === 0) return version.totalBytes;

    const records = await db
      .select({ data: schema.records.data })
      .from(schema.records)
      .where(eq(schema.records.versionId, version.id));

    let totalBytes = 0;
    for (const r of records) {
      totalBytes += Buffer.byteLength(JSON.stringify(r.data), "utf-8");
    }

    const [fileSizeResult] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
      .from(schema.versionFiles)
      .innerJoin(schema.files, eq(schema.versionFiles.fileHash, schema.files.hash))
      .where(eq(schema.versionFiles.versionId, version.id));
    totalBytes += fileSizeResult?.total ?? 0;

    // Persist so we don't recompute next time
    await db
      .update(schema.versions)
      .set({ totalBytes })
      .where(eq(schema.versions.id, version.id));

    return totalBytes;
  }
  // List versions
  app.get("/collections/:owner/:slug/versions", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };
    const { limit, offset } = request.query as { limit?: string; offset?: string };

    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    return db
      .select({
        number: schema.versions.number,
        semver: schema.versions.semver,
        hash: schema.versions.hash,
        message: schema.versions.message,
        appId: schema.versions.appId,
        actorId: schema.versions.actorId,
        recordCount: schema.versions.recordCount,
        fileCount: schema.versions.fileCount,
        totalBytes: schema.versions.totalBytes,
        createdAt: schema.versions.createdAt,
      })
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, collection.id))
      .orderBy(sql`${schema.versions.number} desc`)
      .limit(Math.min(parseInt(limit ?? "50", 10), 100))
      .offset(parseInt(offset ?? "0", 10));
  });

  // Latest version
  app.get("/collections/:owner/:slug/versions/latest", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };
    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    const [version] = await db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, collection.id))
      .orderBy(sql`${schema.versions.number} desc`)
      .limit(1);

    if (!version) return reply.status(404).send({ error: "No versions", statusCode: 404 });
    version.totalBytes = await backfillTotalBytes(version);
    return version;
  });

  // Get version by number
  app.get("/collections/:owner/:slug/versions/:n", async (request, reply) => {
    const { owner, slug, n } = request.params as { owner: string; slug: string; n: string };
    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    const [version] = await db
      .select()
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.number, parseInt(n, 10))),
      )
      .limit(1);

    if (!version) return reply.status(404).send({ error: "Version not found", statusCode: 404 });
    version.totalBytes = await backfillTotalBytes(version);
    return version;
  });

  // Get records for a version
  app.get("/collections/:owner/:slug/versions/:n/records", async (request, reply) => {
    const { owner, slug, n } = request.params as { owner: string; slug: string; n: string };
    const { type, limit, offset } = request.query as {
      type?: string;
      limit?: string;
      offset?: string;
    };

    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    const [version] = await db
      .select()
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.number, parseInt(n, 10))),
      )
      .limit(1);

    if (!version) return reply.status(404).send({ error: "Version not found", statusCode: 404 });

    const conditions = [eq(schema.records.versionId, version.id)];
    if (type) conditions.push(eq(schema.recordTypes.slug, type));

    return db
      .select({
        id: schema.records.recordId,
        type: schema.recordTypes.slug,
        data: schema.records.data,
      })
      .from(schema.records)
      .innerJoin(schema.recordTypes, eq(schema.records.recordTypeId, schema.recordTypes.id))
      .where(and(...conditions))
      .limit(Math.min(parseInt(limit ?? "100", 10), 1000))
      .offset(parseInt(offset ?? "0", 10));
  });

  // List files for a version
  app.get("/collections/:owner/:slug/versions/:n/files", async (request, reply) => {
    const { owner, slug, n } = request.params as { owner: string; slug: string; n: string };
    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    const [version] = await db
      .select()
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.number, parseInt(n, 10))),
      )
      .limit(1);

    if (!version) return reply.status(404).send({ error: "Version not found", statusCode: 404 });

    const fileRows = await db
      .select({
        hash: schema.versionFiles.fileHash,
        size: schema.files.size,
        mimeType: schema.files.mimeType,
        createdAt: schema.files.createdAt,
      })
      .from(schema.versionFiles)
      .innerJoin(schema.files, eq(schema.versionFiles.fileHash, schema.files.hash))
      .where(eq(schema.versionFiles.versionId, version.id));

    // Build file→record reference map by scanning record data for $file refs
    const allRecords = await db
      .select({
        recordId: schema.records.recordId,
        type: schema.recordTypes.slug,
        data: schema.records.data,
      })
      .from(schema.records)
      .innerJoin(schema.recordTypes, eq(schema.records.recordTypeId, schema.recordTypes.id))
      .where(eq(schema.records.versionId, version.id));

    const fileRefs = new Map<string, { recordId: string; type: string; field: string }[]>();
    for (const rec of allRecords) {
      const data = rec.data as Record<string, unknown>;
      for (const [field, val] of Object.entries(data)) {
        if (val && typeof val === "object" && "$file" in (val as any)) {
          const hash = ((val as any).$file as string).replace("sha256:", "");
          if (!fileRefs.has(hash)) fileRefs.set(hash, []);
          fileRefs.get(hash)!.push({ recordId: rec.recordId, type: rec.type, field });
        }
      }
    }

    return fileRows.map((f) => ({
      ...f,
      references: fileRefs.get(f.hash) ?? [],
    }));
  });

  // Get manifest for a version
  app.get("/collections/:owner/:slug/versions/:n/manifest", async (request, reply) => {
    const { owner, slug, n } = request.params as { owner: string; slug: string; n: string };
    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    const [version] = await db
      .select()
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.number, parseInt(n, 10))),
      )
      .limit(1);

    if (!version) return reply.status(404).send({ error: "Version not found", statusCode: 404 });

    const recordIds = await db
      .select({ id: schema.records.recordId, type: schema.recordTypes.slug })
      .from(schema.records)
      .innerJoin(schema.recordTypes, eq(schema.records.recordTypeId, schema.recordTypes.id))
      .where(eq(schema.records.versionId, version.id));

    const fileHashes = await db
      .select({ hash: schema.versionFiles.fileHash })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, version.id));

    // Pin metadata for each record type used in this version. sourceVersionId
    // is null for locally-defined types; for imports it points to the source
    // collection version whose schema was inlined.
    const sourceVersions = aliasedTable(schema.versions, "src_versions");
    const sourceCollections = aliasedTable(schema.collections, "src_collections");
    const sourceAccounts = aliasedTable(schema.accounts, "src_accounts");

    const typePins = await db
      .select({
        slug: schema.recordTypes.slug,
        sourceVersionId: schema.versionRecordTypes.sourceVersionId,
        sourceVersionNumber: sourceVersions.number,
        sourceVersionHash: sourceVersions.hash,
        sourceCollSlug: sourceCollections.slug,
        sourceOwnerSlug: sourceAccounts.slug,
      })
      .from(schema.versionRecordTypes)
      .innerJoin(
        schema.recordTypes,
        eq(schema.versionRecordTypes.recordTypeId, schema.recordTypes.id),
      )
      .leftJoin(sourceVersions, eq(schema.versionRecordTypes.sourceVersionId, sourceVersions.id))
      .leftJoin(sourceCollections, eq(sourceVersions.collectionId, sourceCollections.id))
      .leftJoin(sourceAccounts, eq(sourceCollections.accountId, sourceAccounts.id))
      .where(eq(schema.versionRecordTypes.versionId, version.id));

    const types = typePins.map((t) => ({
      slug: t.slug,
      isImport: t.sourceVersionId !== null,
      ref:
        t.sourceVersionId !== null
          ? `${t.sourceOwnerSlug}/${t.sourceCollSlug}@${t.sourceVersionNumber}/${t.slug}`
          : null,
      hash: t.sourceVersionId !== null ? `sha256:${t.sourceVersionHash}` : null,
    }));

    return {
      version: version.number,
      semver: version.semver,
      hash: version.hash,
      records: recordIds,
      files: fileHashes.map((f) => f.hash),
      types,
    };
  });

  // Push a new version
  app.post(
    "/collections/:owner/:slug/versions",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { owner, slug } = request.params as { owner: string; slug: string };
      const body = request.body as {
        base_version: number | null;
        name?: string;
        description?: string;
        message?: string;
        readme?: string;
        app_id?: string;
        actor_id?: string;
        schema?: unknown;
        changes: {
          added?: { id: string; type: string; data: unknown }[];
          updated?: { id: string; type: string; data: unknown }[];
          removed?: string[];
        };
      };

      const collection = await resolveCollection(owner, slug);
      if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

      const result = await pushVersion(
        {
          collectionId: collection.id,
          baseVersion: body.base_version,
          name: body.name,
          description: body.description,
          message: body.message ?? null,
          readme: body.readme,
          appId: body.app_id ?? null,
          actorId: body.actor_id ?? null,
          schema: body.schema,
          changes: body.changes,
          pushedBy: request.accountId ?? null,
        },
        { accountId: request.accountId ?? null },
      );

      if (!result.ok) {
        return reply.status(result.status).send(result.body);
      }

      return reply.status(201).send({
        version: result.version,
        semver: result.semver,
        hash: result.hash,
        recordCount: result.recordCount,
        fileCount: result.fileCount,
      });
    },
  );

  // Diff between versions
  app.get("/collections/:owner/:slug/versions/:n/diff", async (request, reply) => {
    const { owner, slug, n } = request.params as { owner: string; slug: string; n: string };
    const { from } = request.query as { from?: string };

    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    const targetNum = parseInt(n, 10);
    const fromNum = from ? parseInt(from, 10) : targetNum - 1;

    const [targetVersion] = await db
      .select()
      .from(schema.versions)
      .where(and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.number, targetNum)))
      .limit(1);

    if (!targetVersion) {
      return reply.status(404).send({ error: "Version not found", statusCode: 404 });
    }

    const targetRecords = await db
      .select({
        recordId: schema.records.recordId,
        type: schema.recordTypes.slug,
        data: schema.records.data,
      })
      .from(schema.records)
      .innerJoin(schema.recordTypes, eq(schema.records.recordTypeId, schema.recordTypes.id))
      .where(eq(schema.records.versionId, targetVersion.id));

    let fromVersion: typeof targetVersion | null = null;
    let fromRecords: typeof targetRecords = [];
    if (fromNum > 0) {
      const [fv] = await db
        .select()
        .from(schema.versions)
        .where(and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.number, fromNum)))
        .limit(1);

      if (fv) {
        fromVersion = fv;
        fromRecords = await db
          .select({
            recordId: schema.records.recordId,
            type: schema.recordTypes.slug,
            data: schema.records.data,
          })
          .from(schema.records)
          .innerJoin(schema.recordTypes, eq(schema.records.recordTypeId, schema.recordTypes.id))
          .where(eq(schema.records.versionId, fv.id));
      }
    }

    const fromMap = new Map(fromRecords.map((r) => [r.recordId, r]));
    const targetMap = new Map(targetRecords.map((r) => [r.recordId, r]));

    const added = targetRecords.filter((r) => !fromMap.has(r.recordId));
    const removed = fromRecords.filter((r) => !targetMap.has(r.recordId));
    const updated = targetRecords.filter((r) => {
      const prev = fromMap.get(r.recordId);
      return prev && JSON.stringify(prev.data) !== JSON.stringify(r.data);
    });

    // Compare metadata changes
    const schemaChanged = JSON.stringify(targetVersion.schema) !== JSON.stringify(fromVersion?.schema ?? {});
    const readmeChanged = (targetVersion.readme ?? null) !== (fromVersion?.readme ?? null);

    // Compare file sets
    const targetFiles = await db
      .select({ hash: schema.versionFiles.fileHash })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, targetVersion.id));
    const fromFiles = fromVersion ? await db
      .select({ hash: schema.versionFiles.fileHash })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, fromVersion.id)) : [];
    const targetFileSet = new Set(targetFiles.map((f) => f.hash));
    const fromFileSet = new Set(fromFiles.map((f) => f.hash));
    const filesAdded = targetFiles.filter((f) => !fromFileSet.has(f.hash)).map((f) => f.hash);
    const filesRemoved = fromFiles.filter((f) => !targetFileSet.has(f.hash)).map((f) => f.hash);

    return {
      from: fromNum,
      to: targetNum,
      added: added.map((r) => ({ id: r.recordId, type: r.type, data: r.data })),
      updated: updated.map((r) => ({ id: r.recordId, type: r.type, data: r.data })),
      removed: removed.map((r) => r.recordId),
      meta: {
        schemaChanged,
        readmeChanged,
        readmeFrom: readmeChanged ? (fromVersion?.readme?.slice(0, 100) ?? null) : undefined,
        readmeTo: readmeChanged ? (targetVersion.readme?.slice(0, 100) ?? null) : undefined,
        filesAdded: filesAdded.length,
        filesRemoved: filesRemoved.length,
      },
    };
  });
}

async function resolveCollection(owner: string, slug: string) {
  const [result] = await db
    .select({
      id: schema.collections.id,
      accountId: schema.collections.accountId,
      slug: schema.collections.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(and(eq(schema.accounts.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1);
  return result ?? null;
}
