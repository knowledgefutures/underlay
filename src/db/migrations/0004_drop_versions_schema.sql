-- Backfill the schemas table from versions.schema for any existing data,
-- then drop the versions.schema column (schemas are now record-level only).
-- For fresh installs the versions table is empty so the DO block is a no-op.
-- sha256() is built-in from PostgreSQL 14+.

DO $$
DECLARE
  col RECORD;
  ver RECORD;
  type_slug TEXT;
  type_schema JSONB;
  type_hash TEXT;
  prev_hashes JSONB;
BEGIN
  FOR col IN SELECT id FROM collections LOOP
    prev_hashes := '{}';
    FOR ver IN
      SELECT id, schema
      FROM versions
      WHERE collection_id = col.id
        AND schema IS NOT NULL
        AND schema != '{}'::jsonb
      ORDER BY number ASC
    LOOP
      FOR type_slug, type_schema IN
        SELECT key, value FROM jsonb_each(ver.schema->'properties')
      LOOP
        type_hash := encode(sha256(type_schema::text::bytea), 'hex');
        IF (prev_hashes ->> type_slug) IS DISTINCT FROM type_hash THEN
          INSERT INTO schemas (id, collection_id, version_id, slug, schema, schema_hash, created_at)
          VALUES (gen_random_uuid(), col.id, ver.id, type_slug, type_schema, type_hash, now())
          ON CONFLICT (collection_id, version_id, slug) DO NOTHING;
          prev_hashes := jsonb_set(prev_hashes, ARRAY[type_slug], to_jsonb(type_hash));
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE versions DROP COLUMN schema;
