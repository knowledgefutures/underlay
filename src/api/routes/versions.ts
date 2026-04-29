import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { requireAuth } from "../plugins/auth.js";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function computeVersionHash(
  schemaDoc: unknown,
  recordRows: { recordId: string; type: string; data: unknown }[],
  fileHashes: string[],
): string {
  const canonical = JSON.stringify({
    schema: schemaDoc,
    records: recordRows
      .sort((a, b) => a.recordId.localeCompare(b.recordId))
      .map((r) => ({ id: r.recordId, type: r.type, data: r.data })),
    files: fileHashes.sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function deriveSemver(
  prevSemver: string | null,
  schemaChanged: boolean,
  recordsChanged: boolean,
): string {
  if (!prevSemver) return "v1.0.0";

  const parts = prevSemver.replace(/^v/, "").split(".").map(Number);
  const [major, minor, patch] = [parts[0] ?? 1, parts[1] ?? 0, parts[2] ?? 0];

  if (schemaChanged) return `v${major + 1}.0.0`;
  if (recordsChanged) return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}

export async function versionRoutes(app: FastifyInstance) {
  // Lazily backfill totalBytes for versions that were created before we tracked it
  async function backfillTotalBytes(version: { id: string; totalBytes: number; recordCount: number }) {
    if (version.totalBytes > 0 || version.recordCount === 0) return version.totalBytes;

    const records = await db
      .select({ data: schema.records.data })
      .from(schema.records)
      .where(eq(schema.records.versionId, version.id));

    let totalBytes = 0;
    for (const r of records) {
      totalBytes += Buffer.byteLength(JSON.stringify(r.data), "utf-8");
    }

    const fileRows = await db
      .select({ hash: schema.versionFiles.fileHash })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, version.id));

    for (const f of fileRows) {
      const [file] = await db
        .select({ size: schema.files.size })
        .from(schema.files)
        .where(eq(schema.files.hash, f.hash))
        .limit(1);
      totalBytes += file?.size ?? 0;
    }

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
    if (type) conditions.push(eq(schema.records.type, type));

    return db
      .select({
        id: schema.records.recordId,
        type: schema.records.type,
        data: schema.records.data,
      })
      .from(schema.records)
      .where(and(...conditions))
      .limit(Math.min(parseInt(limit ?? "100", 10), 1000))
      .offset(parseInt(offset ?? "0", 10));
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
      .select({ id: schema.records.recordId, type: schema.records.type })
      .from(schema.records)
      .where(eq(schema.records.versionId, version.id));

    const fileHashes = await db
      .select({ hash: schema.versionFiles.fileHash })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, version.id));

    return {
      version: version.number,
      semver: version.semver,
      hash: version.hash,
      records: recordIds,
      files: fileHashes.map((f) => f.hash),
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
        message?: string;
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

      // Get latest version
      const [latest] = await db
        .select()
        .from(schema.versions)
        .where(eq(schema.versions.collectionId, collection.id))
        .orderBy(sql`${schema.versions.number} desc`)
        .limit(1);

      const currentNumber = latest?.number ?? 0;

      // Optimistic lock
      if (body.base_version !== null && body.base_version !== currentNumber) {
        return reply.status(409).send({
          error: "Version conflict",
          currentVersion: currentNumber,
          statusCode: 409,
        });
      }

      // Build the full record set for this version
      let existingRecords: { recordId: string; type: string; data: unknown }[] = [];
      if (latest) {
        existingRecords = await db
          .select({
            recordId: schema.records.recordId,
            type: schema.records.type,
            data: schema.records.data,
          })
          .from(schema.records)
          .where(eq(schema.records.versionId, latest.id));
      }

      // Apply changes
      const recordMap = new Map(existingRecords.map((r) => [r.recordId, r]));

      for (const rec of body.changes.added ?? []) {
        recordMap.set(rec.id, { recordId: rec.id, type: rec.type, data: rec.data });
      }
      for (const rec of body.changes.updated ?? []) {
        recordMap.set(rec.id, { recordId: rec.id, type: rec.type, data: rec.data });
      }
      for (const id of body.changes.removed ?? []) {
        recordMap.delete(id);
      }

      const newRecords = Array.from(recordMap.values());
      const schemaDoc = body.schema ?? latest?.schema ?? {};
      const schemaChanged = body.schema != null;
      const recordsChanged =
        (body.changes.added?.length ?? 0) > 0 ||
        (body.changes.updated?.length ?? 0) > 0 ||
        (body.changes.removed?.length ?? 0) > 0;

      // Validate records against the JSON Schema
      // The schema's top-level "properties" keys are record type names.
      // Each record is validated against the sub-schema for its type.
      const schemaObj = schemaDoc as Record<string, unknown>;
      const typeSchemas = (schemaObj.properties ?? {}) as Record<string, unknown>;
      const validationErrors: { recordId: string; type: string; errors: string[] }[] = [];

      for (const rec of newRecords) {
        const typeSchema = typeSchemas[rec.type];
        if (!typeSchema) {
          validationErrors.push({
            recordId: rec.recordId,
            type: rec.type,
            errors: [`No schema defined for record type "${rec.type}"`],
          });
          continue;
        }
        const validate = ajv.compile(typeSchema as object);
        if (!validate(rec.data)) {
          validationErrors.push({
            recordId: rec.recordId,
            type: rec.type,
            errors: (validate.errors ?? []).map(
              (e) => `${e.instancePath || "/"} ${e.message ?? "validation failed"}`,
            ),
          });
        }
      }

      if (validationErrors.length > 0) {
        return reply.status(422).send({
          error: "Schema validation failed",
          validationErrors,
          statusCode: 422,
        });
      }

      // Get file hashes from existing version + any new references
      let existingFileHashes: string[] = [];
      if (latest) {
        const vf = await db
          .select({ hash: schema.versionFiles.fileHash })
          .from(schema.versionFiles)
          .where(eq(schema.versionFiles.versionId, latest.id));
        existingFileHashes = vf.map((f) => f.hash);
      }

      // Scan new records for $file references
      const referencedHashes = new Set(existingFileHashes);
      for (const rec of newRecords) {
        const data = rec.data as Record<string, unknown>;
        for (const val of Object.values(data)) {
          if (
            typeof val === "object" &&
            val !== null &&
            "$file" in val &&
            typeof (val as { $file: string }).$file === "string"
          ) {
            const hash = (val as { $file: string }).$file.replace("sha256:", "");
            referencedHashes.add(hash);
          }
        }
      }

      // Check all referenced files exist
      const allFileHashes = Array.from(referencedHashes);
      const filesNeeded: string[] = [];
      for (const hash of allFileHashes) {
        const [file] = await db
          .select()
          .from(schema.files)
          .where(eq(schema.files.hash, hash))
          .limit(1);
        if (!file) filesNeeded.push(hash);
      }

      if (filesNeeded.length > 0) {
        return reply.status(422).send({
          error: "Missing files",
          filesNeeded: filesNeeded.map((h) => `sha256:${h}`),
          statusCode: 422,
        });
      }

      // Compute hash and semver
      const versionHash = computeVersionHash(schemaDoc, newRecords, allFileHashes);
      const semver = deriveSemver(latest?.semver ?? null, schemaChanged, recordsChanged);
      const newNumber = currentNumber + 1;

      // Compute total bytes (records JSON + files)
      let totalBytes = 0;

      // Size of all record data
      for (const rec of newRecords) {
        totalBytes += Buffer.byteLength(JSON.stringify(rec.data), "utf-8");
      }

      // Size of all referenced files
      if (allFileHashes.length > 0) {
        for (const hash of allFileHashes) {
          const [file] = await db
            .select({ size: schema.files.size })
            .from(schema.files)
            .where(eq(schema.files.hash, hash))
            .limit(1);
          totalBytes += file?.size ?? 0;
        }
      }

      // Insert version
      const [version] = await db
        .insert(schema.versions)
        .values({
          collectionId: collection.id,
          number: newNumber,
          semver,
          hash: versionHash,
          baseNumber: body.base_version,
          schema: schemaDoc as any,
          message: body.message ?? null,
          pushedBy: request.accountId ?? null,
          appId: body.app_id ?? null,
          actorId: body.actor_id ?? null,
          recordCount: newRecords.length,
          fileCount: allFileHashes.length,
          totalBytes,
        })
        .returning();

      // Insert records
      if (newRecords.length > 0) {
        await db.insert(schema.records).values(
          newRecords.map((r) => ({
            versionId: version!.id,
            recordId: r.recordId,
            type: r.type,
            data: r.data as any,
          })),
        );
      }

      // Insert version_files
      if (allFileHashes.length > 0) {
        await db.insert(schema.versionFiles).values(
          allFileHashes.map((hash) => ({
            versionId: version!.id,
            fileHash: hash,
          })),
        );
      }

      // Update collection timestamp
      await db
        .update(schema.collections)
        .set({ updatedAt: new Date() })
        .where(eq(schema.collections.id, collection.id));

      return reply.status(201).send({
        version: newNumber,
        semver,
        hash: versionHash,
        recordCount: newRecords.length,
        fileCount: allFileHashes.length,
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
      .select()
      .from(schema.records)
      .where(eq(schema.records.versionId, targetVersion.id));

    let fromRecords: typeof targetRecords = [];
    if (fromNum > 0) {
      const [fromVersion] = await db
        .select()
        .from(schema.versions)
        .where(and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.number, fromNum)))
        .limit(1);

      if (fromVersion) {
        fromRecords = await db
          .select()
          .from(schema.records)
          .where(eq(schema.records.versionId, fromVersion.id));
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

    return {
      from: fromNum,
      to: targetNum,
      added: added.map((r) => ({ id: r.recordId, type: r.type, data: r.data })),
      updated: updated.map((r) => ({ id: r.recordId, type: r.type, data: r.data })),
      removed: removed.map((r) => r.recordId),
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
