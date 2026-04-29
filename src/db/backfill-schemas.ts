/**
 * One-time backfill: populate the schemas table from existing version schemas.
 *
 * For each collection, walks version history in order. For each version that
 * introduced a new or changed per-type schema (compared to the previous version),
 * inserts a row into schemas referencing that version.
 */

import { createHash } from "node:crypto";
import { eq, asc } from "drizzle-orm";
import { db, schema } from "./index.js";

function hashSchema(typeSchema: unknown): string {
  return createHash("sha256").update(JSON.stringify(typeSchema)).digest("hex");
}

async function backfill() {
  console.log("[backfill-schemas] Starting...");

  const collections = await db.select({ id: schema.collections.id }).from(schema.collections);
  console.log(`[backfill-schemas] Found ${collections.length} collections`);

  let totalInserted = 0;

  for (const collection of collections) {
    const versions = await db
      .select({ id: schema.versions.id, schema: schema.versions.schema, semver: schema.versions.semver })
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, collection.id))
      .orderBy(asc(schema.versions.number));

    // Track which hash was last seen for each type slug
    const lastHashBySlug = new Map<string, string>();

    for (const version of versions) {
      const schemaDoc = version.schema as Record<string, any>;
      const properties = (schemaDoc?.properties ?? {}) as Record<string, unknown>;

      const rows: (typeof schema.schemas.$inferInsert)[] = [];

      for (const [slug, typeSchema] of Object.entries(properties)) {
        const hash = hashSchema(typeSchema);
        if (lastHashBySlug.get(slug) !== hash) {
          lastHashBySlug.set(slug, hash);
          rows.push({
            collectionId: collection.id,
            versionId: version.id,
            slug,
            schema: typeSchema as any,
            schemaHash: hash,
          });
        }
      }

      if (rows.length > 0) {
        await db.insert(schema.schemas).values(rows).onConflictDoNothing();
        totalInserted += rows.length;
        console.log(
          `[backfill-schemas] collection ${collection.id} version ${version.id} (${version.semver}): inserted ${rows.length} schema(s)`,
        );
      }
    }
  }

  console.log(`[backfill-schemas] Done. Total inserted: ${totalInserted}`);
  process.exit(0);
}

backfill().catch((err) => {
  console.error("[backfill-schemas] Failed:", err);
  process.exit(1);
});
