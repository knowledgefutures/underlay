import type { FastifyInstance } from "fastify";
import { eq, and, sql, inArray } from "drizzle-orm";
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
  readme: string | null,
): string {
  const canonical = JSON.stringify({
    schema: schemaDoc,
    records: recordRows
      .sort((a, b) => a.recordId.localeCompare(b.recordId))
      .map((r) => ({ id: r.recordId, type: r.type, data: r.data })),
    files: fileHashes.sort(),
    readme: readme ?? null,
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
      .select({ recordId: schema.records.recordId, type: schema.records.type, data: schema.records.data })
      .from(schema.records)
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

      // Pre-compile validators per type (avoid recompiling for each record)
      const validators = new Map<string, ReturnType<typeof ajv.compile>>();
      for (const [typeName, typeSchema] of Object.entries(typeSchemas)) {
        validators.set(typeName, ajv.compile(typeSchema as object));
      }

      for (const rec of newRecords) {
        const validate = validators.get(rec.type);
        if (!validate) {
          validationErrors.push({
            recordId: rec.recordId,
            type: rec.type,
            errors: [`No schema defined for record type "${rec.type}"`],
          });
          continue;
        }
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

      // Check all referenced files exist (single query instead of N+1)
      const allFileHashes = Array.from(referencedHashes);
      if (allFileHashes.length > 0) {
        const existingFiles = await db
          .select({ hash: schema.files.hash })
          .from(schema.files)
          .where(inArray(schema.files.hash, allFileHashes));
        const existingSet = new Set(existingFiles.map((f) => f.hash));
        const filesNeeded = allFileHashes.filter((h) => !existingSet.has(h));

        if (filesNeeded.length > 0) {
          return reply.status(422).send({
            error: "Missing files",
            filesNeeded: filesNeeded.map((h) => `sha256:${h}`),
            statusCode: 422,
          });
        }
      }

      // Resolve readme (carry forward from base version if not provided)
      const readmeValue = body.readme !== undefined ? body.readme : (latest?.readme ?? null);
      const readmeChanged = readmeValue !== (latest?.readme ?? null);

      // Compute hash (includes readme) and semver
      const versionHash = computeVersionHash(schemaDoc, newRecords, allFileHashes, readmeValue);
      const semver = deriveSemver(latest?.semver ?? null, schemaChanged, recordsChanged);
      const newNumber = currentNumber + 1;

      // Check for duplicate hash (truly no changes at all)
      const [existingHash] = await db
        .select({ number: schema.versions.number })
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.collectionId, collection.id),
            eq(schema.versions.hash, versionHash),
          ),
        )
        .limit(1);
      if (existingHash) {
        return reply.status(409).send({
          error: "No changes detected",
          message: `Version ${existingHash.number} already has identical content (hash: ${versionHash.slice(0, 12)}...)`,
          existingVersion: existingHash.number,
        });
      }

      // Compute total bytes (records JSON + files)
      let totalBytes = 0;

      // Size of all record data
      for (const rec of newRecords) {
        totalBytes += Buffer.byteLength(JSON.stringify(rec.data), "utf-8");
      }

      // Size of all referenced files (single query)
      if (allFileHashes.length > 0) {
        const [fileSizeSum] = await db
          .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
          .from(schema.files)
          .where(inArray(schema.files.hash, allFileHashes));
        totalBytes += fileSizeSum?.total ?? 0;
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
          readme: readmeValue,
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

      // Update collection timestamp + optional name/description
      const collectionUpdates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name) collectionUpdates.name = body.name;
      if (body.description !== undefined) collectionUpdates.description = body.description;
      await db
        .update(schema.collections)
        .set(collectionUpdates)
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
          .select()
          .from(schema.records)
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
