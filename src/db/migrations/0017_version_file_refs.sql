CREATE TABLE "version_file_refs" (
	"version_id" bigint NOT NULL,
	"file_hash" text NOT NULL,
	"prefixed" boolean NOT NULL,
	"record_id" text NOT NULL,
	"type" text NOT NULL,
	"field" text NOT NULL,
	"nested" boolean NOT NULL,
	"private" boolean NOT NULL
);
--> statement-breakpoint
-- Backfill every version that owns record rows, before the indexes exist so the
-- load doesn't maintain them row by row. This is insertFileRefs() from
-- src/lib/file-refs.server.ts with no version filter; file-refs.server.test.ts
-- fails if the two drift.
INSERT INTO version_file_refs
  (version_id, file_hash, prefixed, record_id, type, field, nested, private)
WITH RECURSIVE walk (version_id, record_id, type, record_private, field, node, nested) AS (
  SELECT vr.version_id, vr.record_id, vr.type, vr.private, top.key, top.value, false
  FROM version_records vr
  INNER JOIN record_objects ro ON ro.hash = vr.record_hash
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ro.data) = 'object' THEN ro.data ELSE '{}'::jsonb END
  ) top
  WHERE ro.data::text LIKE '%"$file"%'
  UNION ALL
  SELECT w.version_id, w.record_id, w.type, w.record_private, w.field, child.value, true
  FROM walk w
  CROSS JOIN LATERAL (
    SELECT value FROM jsonb_each(
      CASE WHEN jsonb_typeof(w.node) = 'object' THEN w.node ELSE '{}'::jsonb END
    )
    UNION ALL
    SELECT value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(w.node) = 'array' THEN w.node ELSE '[]'::jsonb END
    )
  ) child
  WHERE jsonb_typeof(w.node) IN ('object', 'array')
    AND jsonb_typeof(w.node -> '$file') IS DISTINCT FROM 'string'
)
SELECT DISTINCT
  w.version_id,
  regexp_replace(w.node ->> '$file', 'sha256:', ''),
  left(w.node ->> '$file', 7) = 'sha256:',
  w.record_id,
  w.type,
  w.field,
  w.nested,
  w.record_private
    OR coalesce(s.schema -> 'private' = 'true'::jsonb, false)
    OR coalesce(s.schema -> 'properties' -> w.field -> 'private' = 'true'::jsonb, false)
FROM walk w
LEFT JOIN version_schemas vs ON vs.version_id = w.version_id AND vs.slug = w.type
LEFT JOIN schemas s ON s.id = vs.schema_id
WHERE jsonb_typeof(w.node -> '$file') = 'string';
--> statement-breakpoint
ALTER TABLE "version_file_refs" ADD CONSTRAINT "version_file_refs_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "version_file_refs_version_idx" ON "version_file_refs" USING btree ("version_id","file_hash");--> statement-breakpoint
CREATE INDEX "version_file_refs_file_hash_idx" ON "version_file_refs" USING btree ("file_hash","version_id");
