import type { FastifyInstance } from "fastify";
import { eq, and, desc, ilike, or, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { buildSqliteBuffer, generateAllDDL, generateDDL } from "../../lib/sqlite-gen.js";

// In-memory LRU cache: key = `${collectionId}:${versionNumber}`, value = { buffer, expiresAt }
const sqliteCache = new Map<string, { buffer: Buffer; ddl: string; ddlWithSamples: string; sampleRows: Record<string, Record<string, unknown>>; expiresAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX_ENTRIES = 10;

function cleanExpired() {
  const now = Date.now();
  for (const [key, entry] of sqliteCache) {
    if (entry.expiresAt < now) sqliteCache.delete(key);
  }
}

function evictIfNeeded() {
  while (sqliteCache.size >= CACHE_MAX_ENTRIES) {
    // Evict oldest entry (first key in Map insertion order)
    const firstKey = sqliteCache.keys().next().value;
    if (firstKey) sqliteCache.delete(firstKey);
    else break;
  }
}

// Run cleanup every 5 minutes
setInterval(cleanExpired, 5 * 60 * 1000);

async function getOrBuildSqlite(owner: string, slug: string, versionNumber: number) {
  // Resolve collection
  const [collection] = await db
    .select({ id: schema.collections.id, accountId: schema.collections.accountId, public: schema.collections.public })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.collections.accountId))
    .where(and(eq(schema.accounts.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1);

  if (!collection) return null;

  // Resolve version
  const [version] = await db
    .select({ id: schema.versions.id, number: schema.versions.number })
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.number, versionNumber)))
    .limit(1);

  if (!version) return null;

  const cacheKey = `${collection.id}:${version.number}`;

  // Check cache (re-insert to move to end for LRU ordering)
  const cached = sqliteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    sqliteCache.delete(cacheKey);
    cached.expiresAt = Date.now() + CACHE_TTL_MS;
    sqliteCache.set(cacheKey, cached);
    return cached;
  }

  // Load schemas for this version
  const versionSchemas = await db
    .select({ slug: schema.versionSchemas.slug, schema: schema.schemas.schema })
    .from(schema.versionSchemas)
    .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
    .where(eq(schema.versionSchemas.versionId, version.id));

  const schemasMap: Record<string, any> = {};
  for (const vs of versionSchemas) {
    schemasMap[vs.slug] = vs.schema;
  }

  // Load records
  const records = await db
    .select({ recordId: schema.records.recordId, type: schema.records.type, data: schema.records.data })
    .from(schema.records)
    .where(eq(schema.records.versionId, version.id));

  // Build SQLite
  const buffer = buildSqliteBuffer(schemasMap, records as any);
  const ddl = generateAllDDL(schemasMap);

  // Generate sample data (first row per table) for LLM context
  const sampleRows: Record<string, Record<string, unknown>> = {};
  for (const [typeName] of Object.entries(schemasMap)) {
    const firstRecord = records.find((r) => r.type === typeName);
    if (firstRecord && firstRecord.data && typeof firstRecord.data === "object") {
      sampleRows[typeName] = firstRecord.data as Record<string, unknown>;
    }
  }

  // Build DDL with inline sample rows (each sample right after its CREATE TABLE)
  const ddlWithSamples = Object.entries(schemasMap)
    .map(([name, s]) => {
      const tableDdl = generateDDL(name, s);
      const sample = sampleRows[name];
      if (sample) {
        return tableDdl + `\n-- Example row: ${JSON.stringify(sample)}`;
      }
      return tableDdl;
    })
    .join("\n\n");

  const entry = { buffer, ddl, ddlWithSamples, sampleRows, expiresAt: Date.now() + CACHE_TTL_MS };
  evictIfNeeded();
  sqliteCache.set(cacheKey, entry);
  return entry;
}

export async function queryRoutes(app: FastifyInstance) {
  // GET /query/sqlite/:owner/:slug/:version — Download SQLite file for a version
  app.get<{ Params: { owner: string; slug: string; version: string } }>(
    "/query/sqlite/:owner/:slug/:version",
    async (request, reply) => {
      const { owner, slug, version } = request.params;
      const versionNum = parseInt(version, 10);
      if (isNaN(versionNum)) return reply.status(400).send({ error: "Invalid version number" });

      const result = await getOrBuildSqlite(owner, slug, versionNum);
      if (!result) return reply.status(404).send({ error: "Collection or version not found" });

      reply.header("Content-Type", "application/x-sqlite3");
      reply.header("Content-Disposition", `attachment; filename="${slug}-v${versionNum}.sqlite"`);
      reply.header("Cache-Control", "public, max-age=86400");
      return reply.send(result.buffer);
    },
  );

  // GET /query/ddl/:owner/:slug/:version — Get DDL (schema only) for a version
  app.get<{ Params: { owner: string; slug: string; version: string } }>(
    "/query/ddl/:owner/:slug/:version",
    async (request, reply) => {
      const { owner, slug, version } = request.params;
      const versionNum = parseInt(version, 10);
      if (isNaN(versionNum)) return reply.status(400).send({ error: "Invalid version number" });

      const result = await getOrBuildSqlite(owner, slug, versionNum);
      if (!result) return reply.status(404).send({ error: "Collection or version not found" });

      return { ddl: result.ddl };
    },
  );

  // POST /query/generate-sql — LLM-powered SQL generation from natural language
  app.post<{ Body: { collections: { owner: string; slug: string; version: number }[]; question: string } }>(
    "/query/generate-sql",
    async (request, reply) => {
      const { collections: collectionRefs, question } = request.body as any;

      if (!collectionRefs?.length || !question) {
        return reply.status(400).send({ error: "collections and question are required" });
      }

      const cfAccountId = process.env.CF_ACCOUNT_ID;
      const cfApiToken = process.env.CF_API_TOKEN;

      if (!cfAccountId || !cfApiToken) {
        return reply.status(503).send({
          error: "LLM not configured",
          message: "Set CF_ACCOUNT_ID and CF_API_TOKEN environment variables to enable natural language queries. You can still write SQL directly.",
        });
      }

      // Build DDL with sample rows server-side
      let combinedDdl: string;
      let totalRecords = 0;

      if (collectionRefs.length === 1) {
        const ref = collectionRefs[0];
        const result = await getOrBuildSqlite(ref.owner, ref.slug, ref.version);
        if (!result) return reply.status(404).send({ error: `Collection ${ref.owner}/${ref.slug} v${ref.version} not found` });
        combinedDdl = result.ddlWithSamples;
        // Count records from cache (approximation from the version table already captured)
      } else {
        const parts: string[] = [];
        for (const ref of collectionRefs) {
          const result = await getOrBuildSqlite(ref.owner, ref.slug, ref.version);
          if (!result) return reply.status(404).send({ error: `Collection ${ref.owner}/${ref.slug} v${ref.version} not found` });
          const prefix = ref.slug.replace(/-/g, "_");
          // Prefix table names and add _source column to DDL
          const ddlPrefixed = result.ddlWithSamples
            .replace(/CREATE TABLE "([^"]+)"/g, `CREATE TABLE "${prefix}__$1"`)
            .replace(/\);/g, `,\n  "_source" TEXT\n);`);
          parts.push(`-- Collection: ${ref.owner}/${ref.slug} v${ref.version}\n` + ddlPrefixed);
        }
        combinedDdl = parts.join("\n\n");
      }

      const isMultiCollection = collectionRefs.length > 1;

      const systemPrompt = `You are a SQL assistant for SQLite databases. Given a schema and a user's question, produce a single SELECT query that answers it.

Respond in EXACTLY this format (two sections separated by the marker):

SQL:
<your SELECT query here>

REASONING:
<brief explanation of table/column choices, any assumptions made, and how you interpreted ambiguous terms>

Important rules:
- Examine the "Example row" comments in the schema — they show the ACTUAL data format stored in each column.${isMultiCollection ? `
- When multiple collections are loaded, consider ALL of them in your answer unless the question specifies otherwise.
- Every table has a "_source" column containing the collection identifier (e.g. "account/collection"). For row-level results, include _source as a column. For aggregations, include GROUP_CONCAT(DISTINCT _source) as _source so the user can see which collections contributed to the result.
- When counting across multiple tables, use UNION ALL to combine rows, not JOIN.` : ""}
- Only use JOIN when the question asks about relationships between tables.
- COUNT(*) counts rows.${isMultiCollection ? " Use UNION ALL to combine rows from separate tables before counting." : ""}
- When tables have a prefix like "collection__TableName", always use that full prefixed name.
- Do NOT include columns that don't exist in the schema.`;

      const userPrompt = `Schema:\n${combinedDdl}\n\nQuestion: ${question}`;

      // Log the full prompt for debugging
      app.log.info(`[generate-sql] User prompt:\n${userPrompt}`);

      try {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cfApiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
              max_tokens: 800,
              temperature: 0,
            }),
          },
        );

        if (!response.ok) {
          const text = await response.text();
          app.log.error(`Cloudflare AI error: ${response.status} ${text}`);
          return reply.status(502).send({ error: "LLM request failed", rawResponse: text });
        }

        const data = (await response.json()) as any;
        let raw = data?.result?.response?.trim();

        if (!raw) {
          return reply.status(500).send({ error: "LLM returned empty response", rawResponse: JSON.stringify(data) });
        }

        // Parse structured response
        let sql: string;
        let reasoning: string | undefined;

        const sqlMarker = raw.indexOf("SQL:");
        const reasoningMarker = raw.indexOf("REASONING:");

        if (sqlMarker !== -1 && reasoningMarker !== -1) {
          sql = raw.substring(sqlMarker + 4, reasoningMarker).replace(/```sql\n?/g, "").replace(/```/g, "").trim();
          reasoning = raw.substring(reasoningMarker + 10).trim();
        } else {
          // Fallback: treat entire response as SQL
          sql = raw.replace(/```sql\n?/g, "").replace(/```/g, "").trim();
        }

        // Basic safety: only allow SELECT statements
        const normalized = sql.replace(/--.*$/gm, "").trim().toUpperCase();
        if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
          return reply.status(400).send({
            error: "Generated query is not a SELECT statement",
            sql,
            reasoning,
            rawResponse: raw,
          });
        }

        return { sql, reasoning };
      } catch (err: any) {
        app.log.error(`LLM generation error: ${err.message}`);
        return reply.status(500).send({ error: "Failed to generate SQL" });
      }
    },
  );

  // GET /query/collections/search?q=term — Search collections (public + user's private)
  app.get<{ Querystring: { q?: string } }>("/query/collections/search", async (request) => {
    const { q } = request.query as { q?: string };
    if (!q || q.trim().length < 2) return [];

    const term = `%${q.trim()}%`;
    const userId = request.accountId;

    // Build accessible account IDs (user's own + orgs they belong to)
    let accessibleAccountIds: string[] = [];
    if (userId) {
      const memberships = await db
        .select({ orgId: schema.orgMemberships.orgId })
        .from(schema.orgMemberships)
        .where(eq(schema.orgMemberships.userId, userId));
      accessibleAccountIds = [userId, ...memberships.map((m) => m.orgId)];
    }

    // Query: public collections OR private collections owned by accessible accounts
    const searchCondition = or(
      ilike(schema.accounts.slug, term),
      ilike(schema.collections.slug, term),
      ilike(schema.collections.name, term),
    );

    let whereCondition;
    if (accessibleAccountIds.length > 0) {
      whereCondition = and(
        searchCondition,
        or(
          eq(schema.collections.public, true),
          inArray(schema.collections.accountId, accessibleAccountIds),
        ),
      );
    } else {
      whereCondition = and(searchCondition, eq(schema.collections.public, true));
    }

    const collections = await db
      .select({
        ownerSlug: schema.accounts.slug,
        slug: schema.collections.slug,
        name: schema.collections.name,
        description: schema.collections.description,
        public: schema.collections.public,
      })
      .from(schema.collections)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.collections.accountId))
      .where(whereCondition)
      .limit(20);

    // Get latest version + record count for each match
    const result = [];
    for (const c of collections) {
      const [latestVersion] = await db
        .select({ number: schema.versions.number, semver: schema.versions.semver, recordCount: schema.versions.recordCount })
        .from(schema.versions)
        .innerJoin(schema.collections, eq(schema.collections.id, schema.versions.collectionId))
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.collections.accountId))
        .where(and(eq(schema.accounts.slug, c.ownerSlug), eq(schema.collections.slug, c.slug)))
        .orderBy(desc(schema.versions.number))
        .limit(1);

      result.push({
        ownerSlug: c.ownerSlug,
        slug: c.slug,
        name: c.name,
        description: c.description,
        public: c.public,
        latestVersion: latestVersion?.number ?? null,
        latestSemver: latestVersion?.semver ?? null,
        recordCount: latestVersion?.recordCount ?? 0,
      });
    }

    return result;
  });

  // GET /query/collections/:owner/:slug/versions — List versions for a collection
  app.get<{ Params: { owner: string; slug: string } }>(
    "/query/collections/:owner/:slug/versions",
    async (request, reply) => {
      const { owner, slug } = request.params;

      const versions = await db
        .select({
          number: schema.versions.number,
          semver: schema.versions.semver,
          recordCount: schema.versions.recordCount,
          createdAt: schema.versions.createdAt,
          message: schema.versions.message,
        })
        .from(schema.versions)
        .innerJoin(schema.collections, eq(schema.collections.id, schema.versions.collectionId))
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.collections.accountId))
        .where(
          and(
            eq(schema.accounts.slug, owner),
            eq(schema.collections.slug, slug),
            eq(schema.collections.public, true),
          ),
        )
        .orderBy(desc(schema.versions.number));

      if (versions.length === 0) {
        return reply.status(404).send({ error: "Collection not found or not public" });
      }

      return versions;
    },
  );
}
