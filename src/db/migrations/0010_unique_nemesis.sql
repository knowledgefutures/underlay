-- Chunked manifest upload.
--
-- The inline manifest is a single JSON body — ~58 MB at 500k records and ~360 MB
-- at 3.11M, parsed whole and then copied again by validation. A client can now
-- declare how many record hashes it will send and upload them in chunks through
-- POST .../versions/negotiate/:sessionId/manifest, so the request body stops
-- scaling with the collection.
--
-- manifest_expected is that declared count, and it is load-bearing: a chunked
-- upload has no natural end-of-stream, so commit compares it against the rows
-- actually received and refuses to build a version if they differ. Without it a
-- client that died halfway through would produce a version that silently dropped
-- records. NULL for the inline path, where the manifest arrives atomically.

ALTER TABLE "negotiate_sessions" ADD COLUMN "manifest_expected" integer;
