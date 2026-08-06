ALTER TABLE "version_records" ADD COLUMN "private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill the new per-version record-privacy flag from the (about-to-be-dropped)
-- global record_objects.private, so existing versions keep their historical
-- record-level privacy. Only rows that were actually private are touched, so the
-- cost is proportional to the number of private records — near zero in practice —
-- not to the size of version_records.
UPDATE "version_records" vr SET "private" = true
FROM "record_objects" ro
WHERE ro."hash" = vr."record_hash" AND ro."private" = true;--> statement-breakpoint
ALTER TABLE "record_objects" DROP COLUMN "private";
