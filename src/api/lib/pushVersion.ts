import { eq, and, sql, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { db, schema } from "../../db/index.js";
import {
  isRefValue,
  resolveRef,
  RefResolveError,
  type ResolvedTypeRef,
} from "./recordTypeResolver.js";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export type PushChange = { id: string; type: string; data: unknown };

export type PushInput = {
  collectionId: string;
  baseVersion: number | null;
  name?: string | undefined;
  description?: string | undefined;
  message?: string | null | undefined;
  readme?: string | undefined;
  appId?: string | null | undefined;
  actorId?: string | null | undefined;
  schema?: unknown;
  changes: {
    added?: PushChange[] | undefined;
    updated?: PushChange[] | undefined;
    removed?: string[] | undefined;
  };
  pushedBy?: string | null | undefined;
};

export type PushContext = {
  accountId: string | null;
};

export type PushResult =
  | {
      ok: true;
      version: number;
      semver: string;
      hash: string;
      recordCount: number;
      fileCount: number;
    }
  | {
      ok: false;
      status: 404 | 409 | 422;
      body: Record<string, unknown>;
    };

type Plan = {
  slug: string;
  schema: unknown;
  sourceVersionId: number | null;
  importBadge: ResolvedTypeRef | null;
};

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

export async function pushVersion(input: PushInput, ctx: PushContext): Promise<PushResult> {
  // Look up latest version
  const [latest] = await db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, input.collectionId))
    .orderBy(sql`${schema.versions.number} desc`)
    .limit(1);

  const currentNumber = latest?.number ?? 0;

  // Optimistic lock
  if (input.baseVersion !== null && input.baseVersion !== currentNumber) {
    return {
      ok: false,
      status: 409,
      body: { error: "Version conflict", currentVersion: currentNumber, statusCode: 409 },
    };
  }

  // Build the full record set for this version
  let existingRecords: { recordId: string; type: string; data: unknown }[] = [];
  if (latest) {
    existingRecords = await db
      .select({
        recordId: schema.records.recordId,
        type: schema.recordTypes.slug,
        data: schema.records.data,
      })
      .from(schema.records)
      .innerJoin(schema.recordTypes, eq(schema.records.recordTypeId, schema.recordTypes.id))
      .where(eq(schema.records.versionId, latest.id));
  }

  const recordMap = new Map(existingRecords.map((r) => [r.recordId, r]));
  for (const rec of input.changes.added ?? []) {
    recordMap.set(rec.id, { recordId: rec.id, type: rec.type, data: rec.data });
  }
  for (const rec of input.changes.updated ?? []) {
    recordMap.set(rec.id, { recordId: rec.id, type: rec.type, data: rec.data });
  }
  for (const id of input.changes.removed ?? []) {
    recordMap.delete(id);
  }

  const newRecords = Array.from(recordMap.values());
  const schemaProvided = input.schema !== undefined;
  const schemaDocInput = schemaProvided ? input.schema : (latest?.schema ?? {});
  const recordsChanged =
    (input.changes.added?.length ?? 0) > 0 ||
    (input.changes.updated?.length ?? 0) > 0 ||
    (input.changes.removed?.length ?? 0) > 0;

  // Resolve each property in the input schema to a Plan. For inline entries
  // sourceVersionId is null; for $ref entries we look up the source.
  const schemaProperties = (((schemaDocInput as Record<string, unknown>) ?? {}).properties ??
    {}) as Record<string, unknown>;

  const plans: Plan[] = [];
  for (const [slug, value] of Object.entries(schemaProperties)) {
    if (isRefValue(value)) {
      try {
        const resolved = await resolveRef(value.$ref, { accountId: ctx.accountId });
        plans.push({
          slug,
          schema: resolved.schema,
          sourceVersionId: resolved.sourceVersionId,
          importBadge: resolved,
        });
      } catch (err) {
        if (err instanceof RefResolveError) {
          return {
            ok: false,
            status: 422,
            body: {
              error: "Unknown $ref",
              ref: err.ref,
              reason: err.reason,
              statusCode: 422,
            },
          };
        }
        throw err;
      }
    } else {
      // Reject mixing $ref-shaped objects with sibling keys (handled in isRefValue:
      // any object with a $ref string is treated as a ref). For inline schemas,
      // accept the value verbatim.
      plans.push({ slug, schema: value, sourceVersionId: null, importBadge: null });
    }
  }

  // Carry-forward semantics: if no schema was provided AND there's a base, copy
  // the base version's plans verbatim. (Inline-resolved schemaProperties already
  // handles the "no provided schema, base exists" case via schemaDocInput =
  // latest.schema, but we still need to populate plans from version_record_types
  // to preserve provenance.)
  if (!schemaProvided && latest) {
    const baseLinks = await db
      .select({
        recordTypeId: schema.versionRecordTypes.recordTypeId,
        sourceVersionId: schema.versionRecordTypes.sourceVersionId,
        slug: schema.recordTypes.slug,
      })
      .from(schema.versionRecordTypes)
      .innerJoin(
        schema.recordTypes,
        eq(schema.versionRecordTypes.recordTypeId, schema.recordTypes.id),
      )
      .where(eq(schema.versionRecordTypes.versionId, latest.id));
    // Replace plans (which were built from latest.schema's properties) with the
    // base links so we know which were imports vs local. Schema is already inlined
    // in schemaProperties.
    plans.length = 0;
    for (const link of baseLinks) {
      const subSchema = schemaProperties[link.slug];
      plans.push({
        slug: link.slug,
        schema: subSchema,
        sourceVersionId: link.sourceVersionId ?? null,
        importBadge: null, // we don't fetch source metadata in carry-forward
      });
    }
  }

  // Validate records — each record's type must have a plan, and its data must
  // satisfy the resolved sub-schema.
  const validators = new Map<string, ValidateFunction>();
  for (const p of plans) {
    if (p.schema && typeof p.schema === "object") {
      validators.set(p.slug, ajv.compile(p.schema as object));
    }
  }

  const validationErrors: { recordId: string; type: string; errors: string[] }[] = [];
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
    return {
      ok: false,
      status: 422,
      body: { error: "Schema validation failed", validationErrors, statusCode: 422 },
    };
  }

  // Files
  let existingFileHashes: string[] = [];
  if (latest) {
    const vf = await db
      .select({ hash: schema.versionFiles.fileHash })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, latest.id));
    existingFileHashes = vf.map((f) => f.hash);
  }

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

  const allFileHashes = Array.from(referencedHashes);
  if (allFileHashes.length > 0) {
    const existingFiles = await db
      .select({ hash: schema.files.hash })
      .from(schema.files)
      .where(inArray(schema.files.hash, allFileHashes));
    const existingSet = new Set(existingFiles.map((f) => f.hash));
    const filesNeeded = allFileHashes.filter((h) => !existingSet.has(h));
    if (filesNeeded.length > 0) {
      return {
        ok: false,
        status: 422,
        body: {
          error: "Missing files",
          filesNeeded: filesNeeded.map((h) => `sha256:${h}`),
          statusCode: 422,
        },
      };
    }
  }

  // Build the denormalized projection that lives in versions.schema. Sub-schemas
  // are already fully resolved ($refs inlined); x-underlay-types carries
  // per-alias provenance for clients that want it.
  const projection: Record<string, unknown> = {
    type: "object",
    properties: Object.fromEntries(plans.map((p) => [p.slug, p.schema])),
  };
  const importMeta: Record<string, { ref: string; hash: string }> = {};
  for (const p of plans) {
    if (p.importBadge) {
      importMeta[p.slug] = {
        ref: `${p.importBadge.ownerSlug}/${p.importBadge.collectionSlug}@${p.importBadge.versionNumber}/${p.slug}`,
        hash: `sha256:${p.importBadge.versionHash}`,
      };
    }
  }
  if (Object.keys(importMeta).length > 0) {
    projection["x-underlay-types"] = importMeta;
  }

  const readmeValue = input.readme !== undefined ? input.readme : (latest?.readme ?? null);
  const readmeChanged = readmeValue !== (latest?.readme ?? null);

  const schemaChanged =
    schemaProvided &&
    JSON.stringify(latest?.schema ?? null) !== JSON.stringify(projection);

  const versionHash = computeVersionHash(projection, newRecords, allFileHashes, readmeValue);
  const semver = deriveSemver(latest?.semver ?? null, schemaChanged, recordsChanged);
  const newNumber = currentNumber + 1;

  const [existingHash] = await db
    .select({ number: schema.versions.number })
    .from(schema.versions)
    .where(
      and(
        eq(schema.versions.collectionId, input.collectionId),
        eq(schema.versions.hash, versionHash),
      ),
    )
    .limit(1);
  if (existingHash) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "No changes detected",
        message: `Version ${existingHash.number} already has identical content (hash: ${versionHash.slice(0, 12)}...)`,
        existingVersion: existingHash.number,
      },
    };
  }

  let totalBytes = 0;
  for (const rec of newRecords) {
    totalBytes += Buffer.byteLength(JSON.stringify(rec.data), "utf-8");
  }
  if (allFileHashes.length > 0) {
    const [fileSizeSum] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.files.size}), 0)` })
      .from(schema.files)
      .where(inArray(schema.files.hash, allFileHashes));
    totalBytes += fileSizeSum?.total ?? 0;
  }

  // Insert in a single transaction.
  const result = await db.transaction(async (tx) => {
    // Find or create record_types for each plan slug. (collection_id, slug) is
    // unique; if a concurrent transaction wins the race, we'll see it here.
    const slugToRecordTypeId = new Map<string, string>();
    for (const p of plans) {
      const [existing] = await tx
        .select({ id: schema.recordTypes.id })
        .from(schema.recordTypes)
        .where(
          and(
            eq(schema.recordTypes.collectionId, input.collectionId),
            eq(schema.recordTypes.slug, p.slug),
          ),
        )
        .limit(1);
      if (existing) {
        slugToRecordTypeId.set(p.slug, existing.id);
      } else {
        const [row] = await tx
          .insert(schema.recordTypes)
          .values({
            collectionId: input.collectionId,
            slug: p.slug,
            displayName: p.slug,
          })
          .returning({ id: schema.recordTypes.id });
        slugToRecordTypeId.set(p.slug, row!.id);
      }
    }

    const [version] = await tx
      .insert(schema.versions)
      .values({
        collectionId: input.collectionId,
        number: newNumber,
        semver,
        hash: versionHash,
        baseNumber: input.baseVersion,
        schema: projection as unknown as object,
        message: input.message ?? null,
        readme: readmeValue,
        pushedBy: input.pushedBy ?? null,
        appId: input.appId ?? null,
        actorId: input.actorId ?? null,
        recordCount: newRecords.length,
        fileCount: allFileHashes.length,
        totalBytes,
      })
      .returning();

    if (plans.length > 0) {
      await tx.insert(schema.versionRecordTypes).values(
        plans.map((p) => ({
          versionId: version!.id,
          recordTypeId: slugToRecordTypeId.get(p.slug)!,
          sourceVersionId: p.sourceVersionId,
        })),
      );
    }

    if (newRecords.length > 0) {
      await tx.insert(schema.records).values(
        newRecords.map((r) => ({
          versionId: version!.id,
          recordId: r.recordId,
          recordTypeId: slugToRecordTypeId.get(r.type)!,
          data: r.data as object,
        })),
      );
    }

    if (allFileHashes.length > 0) {
      await tx.insert(schema.versionFiles).values(
        allFileHashes.map((hash) => ({ versionId: version!.id, fileHash: hash })),
      );
    }

    const collectionUpdates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name) collectionUpdates.name = input.name;
    if (input.description !== undefined) collectionUpdates.description = input.description;
    await tx
      .update(schema.collections)
      .set(collectionUpdates)
      .where(eq(schema.collections.id, input.collectionId));

    void readmeChanged;
    return version!;
  });

  return {
    ok: true,
    version: newNumber,
    semver,
    hash: versionHash,
    recordCount: newRecords.length,
    fileCount: allFileHashes.length,
  };
}
