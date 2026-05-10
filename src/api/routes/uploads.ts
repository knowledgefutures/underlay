import type { FastifyInstance } from "fastify";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { requireAuth } from "../plugins/auth.js";
import { createHash } from "node:crypto";
import { getS3ObjectMeta } from "../../lib/s3.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

/** Session expiry: 1 hour from creation */
const SESSION_TTL_MS = 60 * 60 * 1000;

/** Max records per batch request */
const MAX_BATCH_SIZE = 10_000;

// --- Helpers (shared with versions.ts logic) ---

type SchemaEntry = { slug: string; schemaId: string; schema: Record<string, unknown>; schemaHash: string };

async function loadVersionSchemas(versionId: number): Promise<SchemaEntry[]> {
  const rows = await db
    .select({
      slug: schema.versionSchemas.slug,
      schemaId: schema.versionSchemas.schemaId,
      schema: schema.schemas.schema,
      schemaHash: schema.schemas.schemaHash,
    })
    .from(schema.versionSchemas)
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(eq(schema.versionSchemas.versionId, versionId));
  return rows as SchemaEntry[];
}

function getPrivateTypes(schemaEntries: SchemaEntry[]): Set<string> {
  const types = new Set<string>();
  for (const entry of schemaEntries) {
    if ((entry.schema as any)?.private === true) types.add(entry.slug);
  }
  return types;
}

function getPrivateFields(typeSchema: Record<string, unknown>): Set<string> {
  const fields = new Set<string>();
  const props = typeSchema?.properties as Record<string, any> | undefined;
  if (!props) return fields;
  for (const [fieldName, fieldDef] of Object.entries(props)) {
    if (fieldDef?.private === true) fields.add(fieldName);
  }
  return fields;
}

function filterRecordData(data: unknown, privateFields: Set<string>): unknown {
  if (privateFields.size === 0 || typeof data !== "object" || data === null) return data;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!privateFields.has(key)) filtered[key] = value;
  }
  return filtered;
}

function filterTypeSchema(typeSchema: Record<string, unknown>): Record<string, unknown> {
  const props = typeSchema?.properties as Record<string, any> | undefined;
  if (!props) return typeSchema;
  const publicProps: Record<string, unknown> = {};
  for (const [fieldName, fieldDef] of Object.entries(props)) {
    if ((fieldDef as any)?.private === true) continue;
    publicProps[fieldName] = fieldDef;
  }
  const required = (typeSchema.required as string[] | undefined)?.filter(
    (f: string) => !((props[f] as any)?.private === true),
  );
  return { ...typeSchema, properties: publicProps, required };
}

function hashSchema(schemaBody: unknown): string {
  return createHash("sha256").update(JSON.stringify(schemaBody)).digest("hex");
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

export async function uploadRoutes(app: FastifyInstance) {
  // --- Start a chunked upload session ---
  app.post(
    "/collections/:owner/:slug/versions/upload",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { owner, slug } = request.params as { owner: string; slug: string };
      const body = request.body as {
        base_version: number | null;
        message?: string;
        readme?: string;
        app_id?: string;
        actor_id?: string;
        schemas?: Record<string, object>;
      };

      const collection = await resolveCollection(owner, slug);
      if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

      // Verify the caller owns this collection
      if (request.accountId !== collection.accountId) {
        return reply.status(403).send({ error: "Not authorized for this collection", statusCode: 403 });
      }

      // Optimistic lock check at session creation time
      const [latest] = await db
        .select({ number: schema.versions.number })
        .from(schema.versions)
        .where(eq(schema.versions.collectionId, collection.id))
        .orderBy(sql`${schema.versions.number} desc`)
        .limit(1);

      const currentNumber = latest?.number ?? 0;
      if (body.base_version !== null && body.base_version !== currentNumber) {
        return reply.status(409).send({
          error: "Version conflict",
          currentVersion: currentNumber,
          statusCode: 409,
        });
      }

      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      const [session] = await db
        .insert(schema.uploadSessions)
        .values({
          collectionId: collection.id,
          accountId: request.accountId!,
          baseVersion: body.base_version ?? null,
          message: body.message ?? null,
          readme: body.readme ?? null,
          appId: body.app_id ?? null,
          actorId: body.actor_id ?? null,
          schemas: body.schemas ? (body.schemas as any) : null,
          status: "open",
          recordCount: 0,
          expiresAt,
        })
        .returning({ id: schema.uploadSessions.id });

      return reply.status(201).send({
        sessionId: session!.id,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  // --- Append a batch of changes to a session ---
  app.put(
    "/collections/:owner/:slug/versions/upload/:sessionId",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { owner, slug, sessionId } = request.params as {
        owner: string;
        slug: string;
        sessionId: string;
      };
      const body = request.body as {
        changes: {
          added?: { id: string; type: string; data: unknown; private?: boolean }[];
          updated?: { id: string; type: string; data: unknown; private?: boolean }[];
          removed?: string[];
        };
      };

      // Validate session exists and belongs to caller
      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(eq(schema.uploadSessions.id, sessionId))
        .limit(1);

      if (!session) {
        return reply.status(404).send({ error: "Upload session not found", statusCode: 404 });
      }
      if (session.accountId !== request.accountId) {
        return reply.status(403).send({ error: "Not authorized for this session", statusCode: 403 });
      }
      if (session.status !== "open") {
        return reply.status(409).send({
          error: "Session is not open",
          status: session.status,
          statusCode: 409,
        });
      }
      if (new Date(session.expiresAt) < new Date()) {
        await db
          .update(schema.uploadSessions)
          .set({ status: "expired" })
          .where(eq(schema.uploadSessions.id, sessionId));
        return reply.status(410).send({ error: "Upload session expired", statusCode: 410 });
      }

      // Verify collection matches
      const collection = await resolveCollection(owner, slug);
      if (!collection || collection.id !== session.collectionId) {
        return reply.status(404).send({ error: "Collection mismatch", statusCode: 404 });
      }

      // Count total records in this batch
      const addedCount = body.changes.added?.length ?? 0;
      const updatedCount = body.changes.updated?.length ?? 0;
      const removedCount = body.changes.removed?.length ?? 0;
      const batchSize = addedCount + updatedCount + removedCount;

      if (batchSize === 0) {
        return reply.status(400).send({ error: "Empty batch", statusCode: 400 });
      }
      if (batchSize > MAX_BATCH_SIZE) {
        return reply.status(400).send({
          error: `Batch too large. Maximum ${MAX_BATCH_SIZE} records per batch.`,
          statusCode: 400,
        });
      }

      // Insert records into staging table (upsert to handle re-sends)
      const rows: {
        sessionId: string;
        recordId: string;
        type: string | null;
        data: any;
        private: boolean;
        operation: "add" | "update" | "remove";
      }[] = [];

      for (const rec of body.changes.added ?? []) {
        rows.push({
          sessionId,
          recordId: rec.id,
          type: rec.type,
          data: rec.data,
          private: rec.private ?? false,
          operation: "add",
        });
      }
      for (const rec of body.changes.updated ?? []) {
        rows.push({
          sessionId,
          recordId: rec.id,
          type: rec.type,
          data: rec.data,
          private: rec.private ?? false,
          operation: "update",
        });
      }
      for (const id of body.changes.removed ?? []) {
        rows.push({
          sessionId,
          recordId: id,
          type: null,
          data: null,
          private: false,
          operation: "remove",
        });
      }

      // Batch insert (upsert: last write wins for same recordId)
      const BATCH = 1000;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        await db
          .insert(schema.uploadRecords)
          .values(batch)
          .onConflictDoUpdate({
            target: [schema.uploadRecords.sessionId, schema.uploadRecords.recordId],
            set: {
              type: sql`excluded.type`,
              data: sql`excluded.data`,
              private: sql`excluded.private`,
              operation: sql`excluded.operation`,
            },
          });
      }

      // Update session record count
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.uploadRecords)
        .where(eq(schema.uploadRecords.sessionId, sessionId));

      await db
        .update(schema.uploadSessions)
        .set({ recordCount: countResult?.count ?? 0 })
        .where(eq(schema.uploadSessions.id, sessionId));

      return {
        received: { added: addedCount, updated: updatedCount, removed: removedCount },
        totalStaged: countResult?.count ?? 0,
      };
    },
  );

  // --- Get session status ---
  app.get(
    "/collections/:owner/:slug/versions/upload/:sessionId",
    { preHandler: [requireAuth("read")] },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };

      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(eq(schema.uploadSessions.id, sessionId))
        .limit(1);

      if (!session) {
        return reply.status(404).send({ error: "Upload session not found", statusCode: 404 });
      }
      if (session.accountId !== request.accountId) {
        return reply.status(403).send({ error: "Not authorized for this session", statusCode: 403 });
      }

      return {
        sessionId: session.id,
        status: session.status,
        recordCount: session.recordCount,
        baseVersion: session.baseVersion,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
      };
    },
  );

  // --- Finalize: build the version from staged records ---
  app.post(
    "/collections/:owner/:slug/versions/upload/:sessionId/finalize",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { owner, slug, sessionId } = request.params as {
        owner: string;
        slug: string;
        sessionId: string;
      };

      // Load and validate session
      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(eq(schema.uploadSessions.id, sessionId))
        .limit(1);

      if (!session) {
        return reply.status(404).send({ error: "Upload session not found", statusCode: 404 });
      }
      if (session.accountId !== request.accountId) {
        return reply.status(403).send({ error: "Not authorized for this session", statusCode: 403 });
      }
      if (session.status !== "open") {
        return reply.status(409).send({
          error: `Session cannot be finalized (status: ${session.status})`,
          statusCode: 409,
        });
      }
      if (new Date(session.expiresAt) < new Date()) {
        await db
          .update(schema.uploadSessions)
          .set({ status: "expired" })
          .where(eq(schema.uploadSessions.id, sessionId));
        return reply.status(410).send({ error: "Upload session expired", statusCode: 410 });
      }

      const collection = await resolveCollection(owner, slug);
      if (!collection || collection.id !== session.collectionId) {
        return reply.status(404).send({ error: "Collection mismatch", statusCode: 404 });
      }

      // Mark session as finalizing
      await db
        .update(schema.uploadSessions)
        .set({ status: "finalizing" })
        .where(eq(schema.uploadSessions.id, sessionId));

      try {
        // Re-check optimistic lock
        const [latest] = await db
          .select()
          .from(schema.versions)
          .where(eq(schema.versions.collectionId, collection.id))
          .orderBy(sql`${schema.versions.number} desc`)
          .limit(1);

        const currentNumber = latest?.number ?? 0;
        if (session.baseVersion !== null && session.baseVersion !== currentNumber) {
          await db
            .update(schema.uploadSessions)
            .set({ status: "failed" })
            .where(eq(schema.uploadSessions.id, sessionId));
          return reply.status(409).send({
            error: "Version conflict",
            currentVersion: currentNumber,
            statusCode: 409,
          });
        }

        // --- Resolve schemas ---
        let prevSchemaEntries: SchemaEntry[] = [];
        if (latest) {
          prevSchemaEntries = await loadVersionSchemas(latest.id);
        }

        let schemasInput: Record<string, object>;
        if (session.schemas && Object.keys(session.schemas as object).length > 0) {
          schemasInput = session.schemas as Record<string, object>;
        } else if (prevSchemaEntries.length > 0) {
          schemasInput = Object.fromEntries(prevSchemaEntries.map((e) => [e.slug, e.schema]));
        } else {
          await db
            .update(schema.uploadSessions)
            .set({ status: "failed" })
            .where(eq(schema.uploadSessions.id, sessionId));
          return reply.status(422).send({
            error: "Schemas required",
            message: "First version must include a `schemas` map with at least one type definition.",
            statusCode: 422,
          });
        }

        // Hash and upsert schemas
        const newSchemaSet: { slug: string; schemaId: string; schemaHash: string; schema: Record<string, unknown> }[] = [];
        for (const [typeSlug, typeSchema] of Object.entries(schemasInput)) {
          const hash = hashSchema(typeSchema);
          const [existing] = await db
            .select({ id: schema.schemas.id })
            .from(schema.schemas)
            .where(eq(schema.schemas.schemaHash, hash))
            .limit(1);

          let schemaId: string;
          if (existing) {
            schemaId = existing.id;
          } else {
            const [inserted] = await db
              .insert(schema.schemas)
              .values({ schema: typeSchema as any, schemaHash: hash })
              .returning({ id: schema.schemas.id });
            schemaId = inserted!.id;
          }
          newSchemaSet.push({ slug: typeSlug, schemaId, schemaHash: hash, schema: typeSchema as Record<string, unknown> });
        }

        // Check schema changes
        const prevSchemaMap = new Map(prevSchemaEntries.map((e) => [e.slug, e.schemaHash]));
        const newSchemaMap = new Map(newSchemaSet.map((e) => [e.slug, e.schemaHash]));
        let schemaChanged = prevSchemaMap.size !== newSchemaMap.size;
        if (!schemaChanged) {
          for (const [s, hash] of newSchemaMap) {
            if (prevSchemaMap.get(s) !== hash) {
              schemaChanged = true;
              break;
            }
          }
        }

        // Build validators
        const validators = new Map<string, ReturnType<typeof ajv.compile>>();
        for (const entry of newSchemaSet) {
          validators.set(entry.slug, ajv.compile(entry.schema as object));
        }

        // Get file hashes from previous version
        let existingFileHashes: string[] = [];
        if (latest) {
          const vf = await db
            .select({ hash: schema.versionFiles.fileHash })
            .from(schema.versionFiles)
            .where(eq(schema.versionFiles.versionId, latest.id));
          existingFileHashes = vf.map((f) => f.hash);
        }

        // --- Streaming finalize ---
        // Instead of loading all records into memory, we:
        // 1. Materialize the merged record set into a temp table in Postgres
        // 2. Stream through it in sorted batches for validation, hash computation, and insertion
        //
        // The temp table approach lets Postgres handle the merge (existing + staged changes)
        // and gives us sorted cursor access without holding everything in Node memory.

        // Create a temp table with the merged result
        await db.execute(sql`
          CREATE TEMP TABLE _finalize_records (
            record_id text PRIMARY KEY,
            type text NOT NULL,
            data jsonb NOT NULL,
            private boolean NOT NULL DEFAULT false
          ) ON COMMIT DROP
        `);

        // Insert existing records from base version (if any)
        if (latest) {
          await db.execute(sql`
            INSERT INTO _finalize_records (record_id, type, data, private)
            SELECT record_id, type, data, private
            FROM records
            WHERE version_id = ${latest.id}
          `);
        }

        // Apply staged changes (upserts and deletes)
        await db.execute(sql`
          INSERT INTO _finalize_records (record_id, type, data, private)
          SELECT record_id, type, data, COALESCE(private, false)
          FROM upload_records
          WHERE session_id = ${sessionId}
            AND operation IN ('add', 'update')
          ON CONFLICT (record_id) DO UPDATE SET
            type = EXCLUDED.type,
            data = EXCLUDED.data,
            private = EXCLUDED.private
        `);

        // Remove deleted records
        await db.execute(sql`
          DELETE FROM _finalize_records
          WHERE record_id IN (
            SELECT record_id FROM upload_records
            WHERE session_id = ${sessionId} AND operation = 'remove'
          )
        `);

        // Get total count
        const [countResult] = await db.execute(sql`SELECT count(*) as cnt FROM _finalize_records`);
        const totalRecordCount = Number((countResult as any).cnt);

        // Check all record types have schemas
        const [typesResult] = await db.execute(sql`SELECT DISTINCT type FROM _finalize_records`);
        // typesResult is an array of rows
        const allTypes: string[] = (Array.isArray(typesResult) ? typesResult : [typesResult])
          .filter(Boolean)
          .map((r: any) => r.type);
        const missingSchemas = allTypes.filter((t) => !(t in schemasInput));
        if (missingSchemas.length > 0) {
          await db.update(schema.uploadSessions).set({ status: "failed" }).where(eq(schema.uploadSessions.id, sessionId));
          await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`);
          return reply.status(422).send({
            error: "Missing schemas for record types",
            types: missingSchemas,
            statusCode: 422,
          });
        }

        // --- Stream through records in sorted batches ---
        // We compute hashes incrementally and validate + collect file refs + insert records
        const STREAM_BATCH = 5000;
        const privateTypes = getPrivateTypes(newSchemaSet as SchemaEntry[]);

        // Streaming hash state
        const privateHasher = createHash("sha256");
        const publicHasher = createHash("sha256");

        // We build the canonical hash as: {"schemas":{...},"records":[<records>],"files":[...],"readme":...}
        // For streaming, we compute records portion incrementally
        const schemaSetForHash = newSchemaSet
          .map((e) => ({ slug: e.slug, schemaHash: e.schemaHash }))
          .sort((a, b) => a.slug.localeCompare(b.slug));
        const publicSchemaSet = newSchemaSet
          .filter((e) => !privateTypes.has(e.slug))
          .map((e) => ({ slug: e.slug, schemaHash: hashSchema(filterTypeSchema(e.schema)) }))
          .sort((a, b) => a.slug.localeCompare(b.slug));

        // We'll collect all record canonical forms for hashing
        // Using incremental approach: hash prefix, then each record, then suffix
        const schemasCanonical = JSON.stringify(
          Object.fromEntries(schemaSetForHash.map((s) => [s.slug, s.schemaHash])),
        );
        const publicSchemasCanonical = JSON.stringify(
          Object.fromEntries(publicSchemaSet.map((s) => [s.slug, s.schemaHash])),
        );

        // Start building canonical: {"schemas":...,"records":[
        privateHasher.update(`{"schemas":${schemasCanonical},"records":[`);
        publicHasher.update(`{"schemas":${publicSchemasCanonical},"records":[`);

        const referencedHashes = new Set(existingFileHashes);
        const validationErrors: { recordId: string; type: string; errors: string[] }[] = [];
        let totalBytes = 0;
        let recordCount = 0;
        let publicRecordCount = 0;
        let hasChanges = false;
        let cursor = "";
        let hasMore = true;

        // Check if staged records exist (indicates changes)
        const [stagedCount] = await db
          .select({ count: sql<number>`count(*)` })
          .from(schema.uploadRecords)
          .where(eq(schema.uploadRecords.sessionId, sessionId));
        hasChanges = (stagedCount?.count ?? 0) > 0;

        // Insert the new version early to get its ID for record insertion
        // We'll update the hash fields after streaming
        const readmeValue = session.readme !== null ? session.readme : (latest?.readme ?? null);
        const semver = deriveSemver(latest?.semver ?? null, schemaChanged, hasChanges);
        const newNumber = currentNumber + 1;

        // We need to process all records before we can insert the version (need hashes)
        // So we stream in two phases:
        // Phase 1: validate + compute hashes + collect file refs + count bytes
        // Phase 2: insert records (re-stream from temp table)

        while (hasMore) {
          const batch = await db.execute(sql`
            SELECT record_id, type, data, private
            FROM _finalize_records
            WHERE record_id > ${cursor}
            ORDER BY record_id ASC
            LIMIT ${STREAM_BATCH}
          `) as any[];

          const rows = Array.isArray(batch) ? batch : [];
          if (rows.length === 0) {
            hasMore = false;
            break;
          }

          for (const rec of rows) {
            // Validate
            const validate = validators.get(rec.type);
            if (!validate) {
              validationErrors.push({
                recordId: rec.record_id,
                type: rec.type,
                errors: [`No schema defined for record type "${rec.type}"`],
              });
            } else if (!validate(rec.data)) {
              validationErrors.push({
                recordId: rec.record_id,
                type: rec.type,
                errors: (validate.errors ?? []).map(
                  (e) => `${e.instancePath || "/"} ${e.message ?? "validation failed"}`,
                ),
              });
            }

            // Feed into private hash (all records)
            const recCanonical = JSON.stringify({ id: rec.record_id, type: rec.type, data: rec.data });
            if (recordCount > 0) privateHasher.update(",");
            privateHasher.update(recCanonical);
            recordCount++;

            // Feed into public hash (non-private records only, with private fields stripped)
            const isPrivateRecord = rec.private === true;
            const isPrivateType = privateTypes.has(rec.type);
            if (!isPrivateRecord && !isPrivateType) {
              const entry = newSchemaSet.find((e) => e.slug === rec.type);
              const privFields = entry ? getPrivateFields(entry.schema) : new Set<string>();
              const pubData = privFields.size > 0 ? filterRecordData(rec.data, privFields) : rec.data;
              const pubCanonical = JSON.stringify({ id: rec.record_id, type: rec.type, data: pubData });
              if (publicRecordCount > 0) publicHasher.update(",");
              publicHasher.update(pubCanonical);
              publicRecordCount++;
            }

            // Compute bytes
            totalBytes += Buffer.byteLength(JSON.stringify(rec.data), "utf-8");

            // Scan for $file references
            const data = rec.data as Record<string, unknown>;
            for (const val of Object.values(data)) {
              if (
                typeof val === "object" &&
                val !== null &&
                "$file" in val &&
                typeof (val as { $file: string }).$file === "string"
              ) {
                const fileHash = (val as { $file: string }).$file.replace("sha256:", "");
                referencedHashes.add(fileHash);
              }
            }
          }

          cursor = rows[rows.length - 1].record_id;
          if (rows.length < STREAM_BATCH) hasMore = false;
        }

        // Bail on validation errors
        if (validationErrors.length > 0) {
          await db.update(schema.uploadSessions).set({ status: "failed" }).where(eq(schema.uploadSessions.id, sessionId));
          await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`);
          return reply.status(422).send({
            error: "Schema validation failed",
            validationErrors: validationErrors.slice(0, 100), // cap error list
            statusCode: 422,
          });
        }

        // Check all referenced files exist
        const allFileHashes = Array.from(referencedHashes);
        if (allFileHashes.length > 0) {
          const existingFiles = await db
            .select({ hash: schema.files.hash })
            .from(schema.files)
            .where(inArray(schema.files.hash, allFileHashes));
          const existingSet = new Set(existingFiles.map((f) => f.hash));
          let filesNeeded = allFileHashes.filter((h) => !existingSet.has(h));

          // For files not in local DB, check if they exist in S3 (shared bucket)
          if (filesNeeded.length > 0) {
            const stillNeeded: string[] = [];
            for (const h of filesNeeded) {
              const key = `files/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;
              const meta = await getS3ObjectMeta(key);
              if (meta !== null) {
                await db.insert(schema.files).values({
                  hash: h,
                  size: meta.size,
                  mimeType: meta.contentType,
                  storageKey: key,
                }).onConflictDoNothing();
              } else {
                stillNeeded.push(h);
              }
            }
            filesNeeded = stillNeeded;
          }

          if (filesNeeded.length > 0) {
            await db.update(schema.uploadSessions).set({ status: "failed" }).where(eq(schema.uploadSessions.id, sessionId));
            await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`);
            return reply.status(422).send({
              error: "Missing files",
              filesNeeded: filesNeeded.map((h) => `sha256:${h}`),
              statusCode: 422,
            });
          }
        }

        // Finalize hash computation
        const sortedFileHashes = allFileHashes.sort();
        const filesCanonical = JSON.stringify(sortedFileHashes);
        const readmeCanonical = JSON.stringify(readmeValue ?? null);

        privateHasher.update(`],"files":${filesCanonical},"readme":${readmeCanonical}}`);
        publicHasher.update(`],"files":${filesCanonical},"readme":${readmeCanonical}}`);

        const versionHash = "private:" + privateHasher.digest("hex");
        const publicHash = "public:" + publicHasher.digest("hex");

        // Check for duplicate hash
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
          await db.update(schema.uploadSessions).set({ status: "failed" }).where(eq(schema.uploadSessions.id, sessionId));
          await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`);
          return reply.status(409).send({
            error: "No changes detected",
            message: `Version ${existingHash.number} already has identical content`,
            existingVersion: existingHash.number,
          });
        }

        // Add file sizes to totalBytes
        if (allFileHashes.length > 0) {
          const [fileSizeSum] = await db
            .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
            .from(schema.files)
            .where(inArray(schema.files.hash, allFileHashes));
          totalBytes += Number(fileSizeSum?.total ?? 0);
        }

        // Insert version
        const [version] = await db
          .insert(schema.versions)
          .values({
            collectionId: collection.id,
            number: newNumber,
            semver,
            hash: versionHash,
            publicHash,
            baseNumber: session.baseVersion,
            message: session.message ?? null,
            readme: readmeValue,
            pushedBy: request.accountId ?? null,
            appId: session.appId ?? null,
            actorId: session.actorId ?? null,
            recordCount,
            fileCount: allFileHashes.length,
            totalBytes,
          })
          .returning();

        // Phase 2: Insert records from temp table into the real records table (in batches)
        await db.execute(sql`
          INSERT INTO records (version_id, record_id, type, data, private)
          SELECT ${version!.id}, record_id, type, data, private
          FROM _finalize_records
        `);

        // Clean up temp table
        await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`);

        // Insert version_files
        if (allFileHashes.length > 0) {
          await db.insert(schema.versionFiles).values(
            allFileHashes.map((hash) => ({
              versionId: version!.id,
              fileHash: hash,
            })),
          );
        }

        // Insert version_schemas
        await db.insert(schema.versionSchemas).values(
          newSchemaSet.map((entry) => ({
            versionId: version!.id,
            slug: entry.slug,
            schemaId: entry.schemaId,
          })),
        );

        // Update collection timestamp
        await db
          .update(schema.collections)
          .set({ updatedAt: new Date() })
          .where(eq(schema.collections.id, collection.id));

        // Clean up: delete staged records and the session itself
        await db
          .delete(schema.uploadRecords)
          .where(eq(schema.uploadRecords.sessionId, sessionId));
        await db
          .delete(schema.uploadSessions)
          .where(eq(schema.uploadSessions.id, sessionId));

        return reply.status(201).send({
          version: newNumber,
          semver,
          hash: versionHash,
          recordCount,
          fileCount: allFileHashes.length,
        });
      } catch (err) {
        // Mark session as failed on unexpected error
        await db.execute(sql`DROP TABLE IF EXISTS _finalize_records`);
        await db
          .update(schema.uploadSessions)
          .set({ status: "failed" })
          .where(eq(schema.uploadSessions.id, sessionId));
        throw err;
      }
    },
  );

  // --- Abort/cancel a session ---
  app.delete(
    "/collections/:owner/:slug/versions/upload/:sessionId",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };

      const [session] = await db
        .select()
        .from(schema.uploadSessions)
        .where(eq(schema.uploadSessions.id, sessionId))
        .limit(1);

      if (!session) {
        return reply.status(404).send({ error: "Upload session not found", statusCode: 404 });
      }
      if (session.accountId !== request.accountId) {
        return reply.status(403).send({ error: "Not authorized for this session", statusCode: 403 });
      }

      // Delete staged records and session
      await db
        .delete(schema.uploadRecords)
        .where(eq(schema.uploadRecords.sessionId, sessionId));
      await db
        .delete(schema.uploadSessions)
        .where(eq(schema.uploadSessions.id, sessionId));

      return reply.status(204).send();
    },
  );
}
