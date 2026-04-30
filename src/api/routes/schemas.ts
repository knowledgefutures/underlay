import type { FastifyInstance } from "fastify";
import { eq, and, sql, inArray, ilike } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { requireAuth } from "../plugins/auth.js";

export async function schemaRoutes(app: FastifyInstance) {
  // --- Global schema search ---
  // GET /schemas?q=...&slug=...&label=...&schema_hash=...&limit=...&offset=...
  app.get("/schemas", async (request, reply) => {
    const { q, slug: slugFilter, label, schema_hash, limit, offset } = request.query as {
      q?: string;
      slug?: string;
      label?: string;
      schema_hash?: string;
      limit?: string;
      offset?: string;
    };

    const pageLimit = Math.min(parseInt(limit ?? "50", 10), 100);
    const pageOffset = parseInt(offset ?? "0", 10);

    // Search by exact hash
    if (schema_hash) {
      const [row] = await db
        .select()
        .from(schema.schemas)
        .where(eq(schema.schemas.schemaHash, schema_hash))
        .limit(1);

      if (!row) return reply.status(404).send({ error: "Schema not found", statusCode: 404 });

      const labels = await db
        .select({ label: schema.schemaLabels.label })
        .from(schema.schemaLabels)
        .where(eq(schema.schemaLabels.schemaId, row.id));

      const usageCount = await getUsageCount(row.id);

      return {
        ...row,
        labels: labels.map((l) => l.label),
        usageCount,
      };
    }

    // Search by slug (find schemas used as a particular type name)
    if (slugFilter) {
      const vsRows = await db
        .select({ schemaId: schema.versionSchemas.schemaId })
        .from(schema.versionSchemas)
        .where(eq(schema.versionSchemas.slug, slugFilter))
        .groupBy(schema.versionSchemas.schemaId)
        .limit(pageLimit)
        .offset(pageOffset);

      if (vsRows.length === 0) return [];

      const schemaIds = vsRows.map((r) => r.schemaId);
      const schemaRows = await db
        .select()
        .from(schema.schemas)
        .where(inArray(schema.schemas.id, schemaIds));

      const allLabels = await db
        .select({ schemaId: schema.schemaLabels.schemaId, label: schema.schemaLabels.label })
        .from(schema.schemaLabels)
        .where(inArray(schema.schemaLabels.schemaId, schemaIds));

      const labelsMap = new Map<string, string[]>();
      for (const l of allLabels) {
        if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, []);
        labelsMap.get(l.schemaId)!.push(l.label);
      }

      return schemaRows.map((s) => ({
        ...s,
        labels: labelsMap.get(s.id) ?? [],
      }));
    }

    // Search by label
    if (label) {
      const labelRows = await db
        .select({
          schemaId: schema.schemaLabels.schemaId,
          label: schema.schemaLabels.label,
        })
        .from(schema.schemaLabels)
        .where(ilike(schema.schemaLabels.label, `%${label}%`))
        .limit(pageLimit)
        .offset(pageOffset);

      if (labelRows.length === 0) return [];

      const schemaIds = [...new Set(labelRows.map((r) => r.schemaId))];
      const schemaRows = await db
        .select()
        .from(schema.schemas)
        .where(inArray(schema.schemas.id, schemaIds));

      // Gather all labels for these schemas
      const allLabels = await db
        .select({ schemaId: schema.schemaLabels.schemaId, label: schema.schemaLabels.label })
        .from(schema.schemaLabels)
        .where(inArray(schema.schemaLabels.schemaId, schemaIds));

      const labelsMap = new Map<string, string[]>();
      for (const l of allLabels) {
        if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, []);
        labelsMap.get(l.schemaId)!.push(l.label);
      }

      return schemaRows.map((s) => ({
        ...s,
        labels: labelsMap.get(s.id) ?? [],
      }));
    }

    // Full-text search across schema JSON (search for field names, types, etc.)
    if (q) {
      const rows = await db
        .select()
        .from(schema.schemas)
        .where(sql`${schema.schemas.schema}::text ILIKE ${"%" + q + "%"}`)
        .limit(pageLimit)
        .offset(pageOffset);

      const schemaIds = rows.map((r) => r.id);
      const allLabels = schemaIds.length > 0
        ? await db
            .select({ schemaId: schema.schemaLabels.schemaId, label: schema.schemaLabels.label })
            .from(schema.schemaLabels)
            .where(inArray(schema.schemaLabels.schemaId, schemaIds))
        : [];

      const labelsMap = new Map<string, string[]>();
      for (const l of allLabels) {
        if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, []);
        labelsMap.get(l.schemaId)!.push(l.label);
      }

      return rows.map((s) => ({
        ...s,
        labels: labelsMap.get(s.id) ?? [],
      }));
    }

    // No filter: list all schemas
    const rows = await db
      .select()
      .from(schema.schemas)
      .orderBy(sql`${schema.schemas.createdAt} desc`)
      .limit(pageLimit)
      .offset(pageOffset);

    const schemaIds = rows.map((r) => r.id);
    const allLabels = schemaIds.length > 0
      ? await db
          .select({ schemaId: schema.schemaLabels.schemaId, label: schema.schemaLabels.label })
          .from(schema.schemaLabels)
          .where(inArray(schema.schemaLabels.schemaId, schemaIds))
      : [];

    const labelsMap = new Map<string, string[]>();
    for (const l of allLabels) {
      if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, []);
      labelsMap.get(l.schemaId)!.push(l.label);
    }

    return rows.map((s) => ({
      ...s,
      labels: labelsMap.get(s.id) ?? [],
    }));
  });

  // --- Single schema by ID ---
  // GET /schemas/:id
  app.get("/schemas/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [row] = await db
      .select()
      .from(schema.schemas)
      .where(eq(schema.schemas.id, id))
      .limit(1);

    if (!row) return reply.status(404).send({ error: "Schema not found", statusCode: 404 });

    const labels = await db
      .select({ label: schema.schemaLabels.label, createdAt: schema.schemaLabels.createdAt })
      .from(schema.schemaLabels)
      .where(eq(schema.schemaLabels.schemaId, id));

    // Usage: which collections/versions reference this schema
    const usage = await db
      .select({
        slug: schema.versionSchemas.slug,
        semver: schema.versions.semver,
        versionNumber: schema.versions.number,
        collectionSlug: schema.collections.slug,
        owner: schema.accounts.slug,
        isPublic: schema.collections.public,
      })
      .from(schema.versionSchemas)
      .innerJoin(schema.versions, eq(schema.versionSchemas.versionId, schema.versions.id))
      .innerJoin(schema.collections, eq(schema.versions.collectionId, schema.collections.id))
      .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
      .where(and(eq(schema.versionSchemas.schemaId, id), eq(schema.collections.public, true)))
      .orderBy(sql`${schema.versions.createdAt} desc`)
      .limit(50);

    return {
      ...row,
      labels: labels.map((l) => ({ label: l.label, createdAt: l.createdAt })),
      usage: usage.map((u) => ({
        slug: u.slug,
        semver: u.semver,
        versionNumber: u.versionNumber,
        collection: `${u.owner}/${u.collectionSlug}`,
      })),
    };
  });

  // --- Collection schemas (for a specific version or latest) ---
  // GET /collections/:owner/:slug/schemas?version=N
  app.get("/collections/:owner/:slug/schemas", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };
    const { version: versionParam, raw } = request.query as { version?: string; raw?: string };

    // Resolve collection
    const [collection] = await db
      .select({
        id: schema.collections.id,
        accountId: schema.collections.accountId,
        public: schema.collections.public,
      })
      .from(schema.collections)
      .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
      .where(and(eq(schema.accounts.slug, owner), eq(schema.collections.slug, slug)))
      .limit(1);

    if (!collection) return reply.status(404).send({ error: "Collection not found", statusCode: 404 });

    // Visibility check
    if (!collection.public && request.accountId !== collection.accountId) {
      return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
    }

    // Resolve version
    const versionConditions = [eq(schema.versions.collectionId, collection.id)];
    if (versionParam) {
      versionConditions.push(eq(schema.versions.number, parseInt(versionParam, 10)));
    }

    const [version] = await db
      .select({ id: schema.versions.id, number: schema.versions.number, semver: schema.versions.semver })
      .from(schema.versions)
      .where(and(...versionConditions))
      .orderBy(sql`${schema.versions.number} desc`)
      .limit(1);

    if (!version) return reply.status(404).send({ error: "No versions found", statusCode: 404 });

    // Load schemas for this version
    const entries = await db
      .select({
        slug: schema.versionSchemas.slug,
        schemaId: schema.versionSchemas.schemaId,
        schemaBody: schema.schemas.schema,
        schemaHash: schema.schemas.schemaHash,
      })
      .from(schema.versionSchemas)
      .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
      .where(eq(schema.versionSchemas.versionId, version.id));

    // Load labels for all referenced schemas (unless raw mode)
    let labelsMap = new Map<string, string[]>();
    if (raw !== "true" && entries.length > 0) {
      const schemaIds = entries.map((e) => e.schemaId);
      const allLabels = await db
        .select({ schemaId: schema.schemaLabels.schemaId, label: schema.schemaLabels.label })
        .from(schema.schemaLabels)
        .where(inArray(schema.schemaLabels.schemaId, schemaIds));

      for (const l of allLabels) {
        if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, []);
        labelsMap.get(l.schemaId)!.push(l.label);
      }
    }

    return {
      version: version.number,
      semver: version.semver,
      schemas: entries.map((e) => {
        const labels = labelsMap.get(e.schemaId) ?? [];
        const body = raw === "true"
          ? e.schemaBody
          : labels.length > 0
            ? { ...(e.schemaBody as object), "x-underlay-labels": labels }
            : e.schemaBody;

        return {
          slug: e.slug,
          schemaId: e.schemaId,
          schemaHash: e.schemaHash,
          schema: body,
        };
      }),
    };
  });

  // --- Label management ---

  // Add a label to a schema
  // POST /schemas/:id/labels { label: "schema.org/Person" }
  app.post(
    "/schemas/:id/labels",
    { preHandler: [requireAuth("write")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { label } = request.body as { label: string };

      if (!label || typeof label !== "string" || label.trim().length === 0) {
        return reply.status(400).send({ error: "Label is required", statusCode: 400 });
      }

      // Verify schema exists
      const [existing] = await db
        .select({ id: schema.schemas.id })
        .from(schema.schemas)
        .where(eq(schema.schemas.id, id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({ error: "Schema not found", statusCode: 404 });
      }

      // Upsert label (ignore conflict on duplicate)
      try {
        const [inserted] = await db
          .insert(schema.schemaLabels)
          .values({ schemaId: id, label: label.trim() })
          .onConflictDoNothing()
          .returning();

        if (!inserted) {
          return { status: "exists", schemaId: id, label: label.trim() };
        }

        return reply.status(201).send({ status: "created", schemaId: id, label: label.trim() });
      } catch (err: any) {
        return reply.status(500).send({ error: "Failed to add label", statusCode: 500 });
      }
    },
  );

  // Remove a label from a schema
  // DELETE /schemas/:id/labels/:label
  app.delete(
    "/schemas/:id/labels/:label",
    { preHandler: [requireAuth("admin")] },
    async (request, reply) => {
      const { id, label } = request.params as { id: string; label: string };

      const result = await db
        .delete(schema.schemaLabels)
        .where(and(eq(schema.schemaLabels.schemaId, id), eq(schema.schemaLabels.label, label)))
        .returning();

      if (result.length === 0) {
        return reply.status(404).send({ error: "Label not found", statusCode: 404 });
      }

      return { status: "deleted", schemaId: id, label };
    },
  );
}

// --- Helpers ---

async function getUsageCount(schemaId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(distinct ${schema.versionSchemas.versionId})::int` })
    .from(schema.versionSchemas)
    .where(eq(schema.versionSchemas.schemaId, schemaId));
  return result?.count ?? 0;
}
