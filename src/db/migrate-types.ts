import { db, schema } from "./index.js";
import { eq, and, isNull, sql } from "drizzle-orm";

// Backfill record_types / version_record_types / records.record_type_id from
// the legacy versions.schema.properties + records.type representation. Run
// after migration 0003 (which adds the new tables and the nullable column)
// and before migration 0004 (which sets NOT NULL and drops records.type).
//
// Idempotent — re-running on partially backfilled data finishes the job.

async function migrateTypes() {
  console.log("[migrate-types] Starting backfill...");

  const allVersions = await db
    .select({
      id: schema.versions.id,
      collectionId: schema.versions.collectionId,
      number: schema.versions.number,
      schemaDoc: schema.versions.schema,
    })
    .from(schema.versions)
    .orderBy(sql`${schema.versions.collectionId}, ${schema.versions.number}`);

  console.log(`[migrate-types] Walking ${allVersions.length} versions...`);

  for (const v of allVersions) {
    const props = ((v.schemaDoc as Record<string, unknown>)?.properties ?? {}) as Record<
      string,
      unknown
    >;

    for (const slug of Object.keys(props)) {
      // 1. Find or create record_type for (collection, slug)
      let [rt] = await db
        .select({ id: schema.recordTypes.id })
        .from(schema.recordTypes)
        .where(
          and(
            eq(schema.recordTypes.collectionId, v.collectionId),
            eq(schema.recordTypes.slug, slug),
          ),
        )
        .limit(1);

      if (!rt) {
        [rt] = await db
          .insert(schema.recordTypes)
          .values({
            collectionId: v.collectionId,
            slug,
            displayName: slug,
          })
          .returning({ id: schema.recordTypes.id });
      }

      // 2. Link version → record_type (sourceVersionId null since legacy schemas had no $ref)
      await db
        .insert(schema.versionRecordTypes)
        .values({ versionId: v.id, recordTypeId: rt!.id, sourceVersionId: null })
        .onConflictDoNothing();
    }

    // 3. Backfill records.record_type_id by joining on slug for this version
    await db.execute(sql`
      UPDATE records r
      SET record_type_id = rt.id
      FROM record_types rt
      WHERE r.version_id = ${v.id}
        AND rt.collection_id = ${v.collectionId}
        AND rt.slug = r.type
        AND r.record_type_id IS NULL
    `);
  }

  // 4. Sanity check
  const orphans = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.records)
    .where(isNull(schema.records.recordTypeId));

  const orphanCount = orphans[0]?.count ?? 0;
  if (orphanCount > 0) {
    console.error(`[migrate-types] FAIL: ${orphanCount} records still have NULL record_type_id`);
    process.exit(1);
  }

  const recordTypeCount = await db.select({ count: sql<number>`count(*)::int` }).from(schema.recordTypes);
  const linkCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.versionRecordTypes);

  console.log(
    `[migrate-types] Done. ${recordTypeCount[0]?.count ?? 0} record types, ${linkCount[0]?.count ?? 0} version links, 0 orphan records.`,
  );
  process.exit(0);
}

migrateTypes().catch((err) => {
  console.error("[migrate-types] Failed:", err);
  process.exit(1);
});
