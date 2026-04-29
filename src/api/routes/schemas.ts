import type { FastifyInstance } from "fastify";
import { eq, and, ne, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function hashTypeSchema(typeSchema: unknown): string {
  return createHash("sha256").update(JSON.stringify(typeSchema)).digest("hex");
}

function inferSchema(data: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    if (val === null || val === undefined) {
      properties[key] = {};
    } else if (typeof val === "string") {
      properties[key] = { type: "string" };
    } else if (typeof val === "number") {
      properties[key] = { type: "number" };
    } else if (typeof val === "boolean") {
      properties[key] = { type: "boolean" };
    } else if (Array.isArray(val)) {
      properties[key] = { type: "array" };
    } else if (typeof val === "object") {
      properties[key] = { type: "object" };
    }
  }
  return { type: "object", properties };
}

type SchemaRow = {
  id: string;
  slug: string;
  schema: unknown;
  schemaHash: string;
  sourceSchemaId: string | null;
  collectionSlug: string;
  ownerSlug: string;
  semver: string;
};

async function buildUsedBy(
  schemaHash: string,
  excludeId: string,
): Promise<{ ownerSlug: string; collectionSlug: string; semver: string }[]> {
  return db
    .select({
      ownerSlug: schema.accounts.slug,
      collectionSlug: schema.collections.slug,
      semver: schema.versions.semver,
    })
    .from(schema.schemas)
    .innerJoin(schema.versions, eq(schema.schemas.versionId, schema.versions.id))
    .innerJoin(schema.collections, eq(schema.schemas.collectionId, schema.collections.id))
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(
      and(
        eq(schema.schemas.schemaHash, schemaHash),
        ne(schema.schemas.id, excludeId),
        eq(schema.collections.public, true),
      ),
    )
    .limit(20);
}

async function resolveCollection(owner: string, slug: string) {
  const [result] = await db
    .select({
      id: schema.collections.id,
      public: schema.collections.public,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(and(eq(schema.accounts.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1);
  return result ?? null;
}

export async function schemaRoutes(app: FastifyInstance) {
  // Global schema search
  app.get("/schemas", async (request) => {
    const { q, slug, schema_hash, org, page } = request.query as {
      q?: string;
      slug?: string;
      schema_hash?: string;
      org?: string;
      page?: string;
    };

    const pageNum = Math.max(1, parseInt(page ?? "1", 10));
    const pageSize = 50;
    const offset = (pageNum - 1) * pageSize;

    const conditions = [eq(schema.collections.public, true)];
    if (slug) conditions.push(eq(schema.schemas.slug, slug));
    if (schema_hash) conditions.push(eq(schema.schemas.schemaHash, schema_hash));
    if (org) conditions.push(eq(schema.accounts.slug, org));
    if (q) conditions.push(sql`${schema.schemas.slug} ilike ${"%" + q + "%"}`);

    const rows = await db
      .select({
        id: schema.schemas.id,
        slug: schema.schemas.slug,
        schema: schema.schemas.schema,
        schemaHash: schema.schemas.schemaHash,
        sourceSchemaId: schema.schemas.sourceSchemaId,
        collectionSlug: schema.collections.slug,
        ownerSlug: schema.accounts.slug,
        semver: schema.versions.semver,
      })
      .from(schema.schemas)
      .innerJoin(schema.versions, eq(schema.schemas.versionId, schema.versions.id))
      .innerJoin(schema.collections, eq(schema.schemas.collectionId, schema.collections.id))
      .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
      .where(and(...conditions))
      .orderBy(sql`${schema.schemas.createdAt} desc`)
      .limit(pageSize)
      .offset(offset);

    const withUsedBy = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        usedBy: await buildUsedBy(row.schemaHash, row.id),
      })),
    );

    return { schemas: withUsedBy, page: pageNum, pageSize };
  });

  // Org/user schemas
  app.get("/accounts/:owner/schemas", async (request, reply) => {
    const { owner } = request.params as { owner: string };

    const [account] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, owner))
      .limit(1);

    if (!account) return reply.status(404).send({ error: "Account not found", statusCode: 404 });

    const rows = await db
      .select({
        id: schema.schemas.id,
        slug: schema.schemas.slug,
        schema: schema.schemas.schema,
        schemaHash: schema.schemas.schemaHash,
        sourceSchemaId: schema.schemas.sourceSchemaId,
        collectionSlug: schema.collections.slug,
        ownerSlug: schema.accounts.slug,
        semver: schema.versions.semver,
      })
      .from(schema.schemas)
      .innerJoin(schema.versions, eq(schema.schemas.versionId, schema.versions.id))
      .innerJoin(schema.collections, eq(schema.schemas.collectionId, schema.collections.id))
      .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
      .where(
        and(eq(schema.accounts.id, account.id), eq(schema.collections.public, true)),
      )
      .orderBy(schema.collections.slug, sql`${schema.schemas.createdAt} desc`);

    const withUsedBy = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        usedBy: await buildUsedBy(row.schemaHash, row.id),
      })),
    );

    return withUsedBy;
  });

  // Collection schemas (all versions)
  app.get("/collections/:owner/:slug/schemas", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };

    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    const rows = await db
      .select({
        id: schema.schemas.id,
        slug: schema.schemas.slug,
        schema: schema.schemas.schema,
        schemaHash: schema.schemas.schemaHash,
        sourceSchemaId: schema.schemas.sourceSchemaId,
        versionId: schema.schemas.versionId,
        semver: schema.versions.semver,
        createdAt: schema.schemas.createdAt,
      })
      .from(schema.schemas)
      .innerJoin(schema.versions, eq(schema.schemas.versionId, schema.versions.id))
      .where(eq(schema.schemas.collectionId, collection.id))
      .orderBy(sql`${schema.versions.number} desc`, schema.schemas.slug);

    const withUsedBy = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        usedBy: await buildUsedBy(row.schemaHash, row.id),
      })),
    );

    return withUsedBy;
  });

  // Single schema by versionId + slug
  app.get("/collections/:owner/:slug/schemas/:versionId/:typeSlug", async (request, reply) => {
    const { owner, slug, versionId, typeSlug } = request.params as {
      owner: string;
      slug: string;
      versionId: string;
      typeSlug: string;
    };

    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    const [row] = await db
      .select({
        id: schema.schemas.id,
        slug: schema.schemas.slug,
        schema: schema.schemas.schema,
        schemaHash: schema.schemas.schemaHash,
        sourceSchemaId: schema.schemas.sourceSchemaId,
        semver: schema.versions.semver,
        createdAt: schema.schemas.createdAt,
      })
      .from(schema.schemas)
      .innerJoin(schema.versions, eq(schema.schemas.versionId, schema.versions.id))
      .where(
        and(
          eq(schema.schemas.collectionId, collection.id),
          eq(schema.schemas.versionId, parseInt(versionId, 10)),
          eq(schema.schemas.slug, typeSlug),
        ),
      )
      .limit(1);

    if (!row) return reply.status(404).send({ error: "Schema not found", statusCode: 404 });

    return { ...row, usedBy: await buildUsedBy(row.schemaHash, row.id) };
  });

  // Infer schemas from first record per type, and find compatible suggestions
  app.post("/collections/:owner/:slug/schemas/infer", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };

    const collection = await resolveCollection(owner, slug);
    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    // Get latest version
    const [latestVersion] = await db
      .select({ id: schema.versions.id })
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, collection.id))
      .orderBy(sql`${schema.versions.number} desc`)
      .limit(1);

    if (!latestVersion) return reply.status(404).send({ error: "No versions", statusCode: 404 });

    // Get all distinct types in this version
    const typeRows = await db
      .selectDistinct({ type: schema.records.type })
      .from(schema.records)
      .where(eq(schema.records.versionId, latestVersion.id));

    const result: Record<
      string,
      {
        inferredSchema: Record<string, unknown>;
        schemaHash: string;
        exactMatches: SchemaRow[];
        compatibleMatches: SchemaRow[];
      }
    > = {};

    for (const { type } of typeRows) {
      // Get first record of this type
      const [firstRecord] = await db
        .select({ data: schema.records.data })
        .from(schema.records)
        .where(
          and(eq(schema.records.versionId, latestVersion.id), eq(schema.records.type, type)),
        )
        .limit(1);

      if (!firstRecord) continue;

      const inferredSchema = inferSchema(firstRecord.data as Record<string, unknown>);
      const schemaHash = hashTypeSchema(inferredSchema);

      // Exact structural matches from other public collections
      const exactMatches = await db
        .select({
          id: schema.schemas.id,
          slug: schema.schemas.slug,
          schema: schema.schemas.schema,
          schemaHash: schema.schemas.schemaHash,
          sourceSchemaId: schema.schemas.sourceSchemaId,
          collectionSlug: schema.collections.slug,
          ownerSlug: schema.accounts.slug,
          semver: schema.versions.semver,
        })
        .from(schema.schemas)
        .innerJoin(schema.versions, eq(schema.schemas.versionId, schema.versions.id))
        .innerJoin(schema.collections, eq(schema.schemas.collectionId, schema.collections.id))
        .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
        .where(
          and(
            eq(schema.schemas.schemaHash, schemaHash),
            ne(schema.schemas.collectionId, collection.id),
            eq(schema.collections.public, true),
          ),
        )
        .limit(10);

      // Same-name matches from other public collections, filtered by compatibility with the first record
      const sameNameRows = await db
        .select({
          id: schema.schemas.id,
          slug: schema.schemas.slug,
          schema: schema.schemas.schema,
          schemaHash: schema.schemas.schemaHash,
          sourceSchemaId: schema.schemas.sourceSchemaId,
          collectionSlug: schema.collections.slug,
          ownerSlug: schema.accounts.slug,
          semver: schema.versions.semver,
        })
        .from(schema.schemas)
        .innerJoin(schema.versions, eq(schema.schemas.versionId, schema.versions.id))
        .innerJoin(schema.collections, eq(schema.schemas.collectionId, schema.collections.id))
        .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
        .where(
          and(
            eq(schema.schemas.slug, type),
            ne(schema.schemas.collectionId, collection.id),
            eq(schema.collections.public, true),
          ),
        )
        .limit(20);

      // Validate first record against each candidate schema; keep only passing ones
      const compatibleMatches = sameNameRows.filter((candidate) => {
        try {
          const validate = ajv.compile(candidate.schema as object);
          return validate(firstRecord.data);
        } catch {
          return false;
        }
      });

      result[type] = { inferredSchema, schemaHash, exactMatches, compatibleMatches };
    }

    return result;
  });
}
