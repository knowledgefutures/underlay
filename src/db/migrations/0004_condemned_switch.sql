-- Backfill record_types for any pre-existing records (no-op on a fresh database).
-- On an existing dev DB, records.type still holds the slug and record_type_id is NULL.
INSERT INTO record_types (collection_id, slug, display_name)
SELECT DISTINCT v.collection_id, r.type, r.type
FROM records r
JOIN versions v ON r.version_id = v.id
WHERE r.record_type_id IS NULL
ON CONFLICT (collection_id, slug) DO NOTHING;
--> statement-breakpoint

-- Backfill version_record_types (provenance: all legacy types count as locally defined).
INSERT INTO version_record_types (version_id, record_type_id)
SELECT DISTINCT r.version_id, rt.id
FROM records r
JOIN versions v ON r.version_id = v.id
JOIN record_types rt ON rt.collection_id = v.collection_id AND rt.slug = r.type
WHERE r.record_type_id IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Fill records.record_type_id from the slug.
UPDATE records r
SET record_type_id = rt.id
FROM versions v, record_types rt
WHERE r.version_id = v.id
  AND rt.collection_id = v.collection_id
  AND rt.slug = r.type
  AND r.record_type_id IS NULL;
--> statement-breakpoint

ALTER TABLE "records" ALTER COLUMN "record_type_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "records" DROP COLUMN "type";