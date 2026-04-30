import { db, schema } from "./index.js";
import { eq, and, sql } from "drizzle-orm";

export type SchemaRow = {
  id: string;
  slug: string;
  schema: unknown;
  schemaHash: string;
  sourceSchemaId: string | null;
};

/**
 * Returns the latest schema row for each type in a collection, as of a given version number.
 * Only types introduced in versions ≤ versionNumber are included.
 */
export async function getSchemasAsOf(
  collectionId: string,
  versionNumber: number,
): Promise<Map<string, SchemaRow>> {
  const allRows = await db
    .select({
      id: schema.schemas.id,
      slug: schema.schemas.slug,
      typeSchema: schema.schemas.schema,
      schemaHash: schema.schemas.schemaHash,
      sourceSchemaId: schema.schemas.sourceSchemaId,
      versionNumber: schema.versions.number,
    })
    .from(schema.schemas)
    .innerJoin(schema.versions, eq(schema.schemas.versionId, schema.versions.id))
    .where(
      and(
        eq(schema.schemas.collectionId, collectionId),
        sql`${schema.versions.number} <= ${versionNumber}`,
      ),
    )
    .orderBy(sql`${schema.schemas.slug} ASC, ${schema.versions.number} DESC`);

  const result = new Map<string, SchemaRow>();
  const seen = new Set<string>();
  for (const row of allRows) {
    if (!seen.has(row.slug)) {
      seen.add(row.slug);
      result.set(row.slug, {
        id: row.id,
        slug: row.slug,
        schema: row.typeSchema,
        schemaHash: row.schemaHash,
        sourceSchemaId: row.sourceSchemaId,
      });
    }
  }
  return result;
}
