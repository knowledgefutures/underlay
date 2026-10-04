-- Corrects 0008 and adds async finalize.
--
-- 1. The index 0008 created is dropped. It was meant to make the version-hash
--    streams index-ordered, but those must read in byte order and so sort with
--    COLLATE "C", which cannot use an index built in the database's default
--    collation — the planner sorted anyway. Measured at 209 MB of pure write
--    amplification: maintained by every commit write-back, usable by no read,
--    and blocking HOT updates on the column it covered. Dropping it is most of
--    the reason a 500k commit went from 151 s back to ~60 s.
--
-- 2. `submitted` is set when a record arrives through the records endpoint,
--    which validates it against the session's schemas. Commit uses it to skip
--    re-running AJV over records validated minutes earlier; on a first push
--    that is every record.
--
-- 3. `result` / `error` / `finalize_started_at` back the async finalize: a
--    commit can now return 202 and build the version in the background, so its
--    outcome has to live somewhere the client can poll. `result` holds what the
--    synchronous path would have returned inline, `error` the rejection body it
--    would have returned instead, and `finalize_started_at` tells a finalize
--    still running apart from one killed by a restart — which is what
--    tool:cleanupSessions sweeps on.
--
-- The `status` column gains 'committing' and 'failed'. It is plain text with the
-- allowed values enforced in the application, so no constraint change here.
--
-- IF EXISTS on the DROP: 0008 is unreleased, so a database that never ran it is
-- a normal state rather than an error.

DROP INDEX IF EXISTS "nsm_session_final_hash_idx";--> statement-breakpoint
ALTER TABLE "negotiate_session_manifest" ADD COLUMN "submitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "negotiate_sessions" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "negotiate_sessions" ADD COLUMN "error" jsonb;--> statement-breakpoint
ALTER TABLE "negotiate_sessions" ADD COLUMN "finalize_started_at" timestamp with time zone;