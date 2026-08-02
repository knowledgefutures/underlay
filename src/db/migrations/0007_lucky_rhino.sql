-- Denormalize record_id + type onto version_records, and store per-type counts
-- on versions.
--
-- Hand-edited after drizzle-kit generate: the generated file added both columns
-- as NOT NULL in one statement, which fails on a non-empty table. Columns are
-- added nullable, backfilled, then constrained.
--
-- The backfill rewrites every version_records row and holds an ACCESS EXCLUSIVE
-- lock for the duration. At the current scale (hundreds of thousands of rows)
-- that is seconds; on a much larger table, run the UPDATE in batches out of
-- band first so the in-migration UPDATE is a no-op.

ALTER TABLE "version_records" ADD COLUMN "record_id" text;--> statement-breakpoint
ALTER TABLE "version_records" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "type_counts" jsonb;--> statement-breakpoint

UPDATE "version_records" vr
SET "record_id" = ro."record_id", "type" = ro."type"
FROM "record_objects" ro
WHERE ro."hash" = vr."record_hash" AND vr."record_id" IS NULL;--> statement-breakpoint

ALTER TABLE "version_records" ALTER COLUMN "record_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "version_records" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint

CREATE INDEX "version_records_version_record_idx" ON "version_records" USING btree ("version_id","record_id");--> statement-breakpoint
CREATE INDEX "version_records_version_type_record_idx" ON "version_records" USING btree ("version_id","type","record_id");--> statement-breakpoint

UPDATE "versions" v
SET "type_counts" = c.counts
FROM (
  SELECT "version_id", jsonb_object_agg("type", n) AS counts
  FROM (
    SELECT "version_id", "type", count(*) AS n
    FROM "version_records"
    GROUP BY "version_id", "type"
  ) per_type
  GROUP BY "version_id"
) c
WHERE c."version_id" = v."id";
