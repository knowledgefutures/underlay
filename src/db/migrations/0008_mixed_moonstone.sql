-- Commit scratch columns on the negotiate session manifest.
--
-- The commit's validation pass writes each record's post-strip hash and public
-- content-address back here instead of accumulating them in app memory; the
-- version hash and the version_records insert are then streamed out of Postgres
-- in sorted order.
--
-- Nullable with no backfill: they are only ever written during a commit, and
-- sessions expire after 10 minutes, so nothing pre-existing needs a value.

ALTER TABLE "negotiate_session_manifest" ADD COLUMN "final_hash" text;--> statement-breakpoint
ALTER TABLE "negotiate_session_manifest" ADD COLUMN "public_hash" text;--> statement-breakpoint
CREATE INDEX "nsm_session_final_hash_idx" ON "negotiate_session_manifest" USING btree ("session_id","final_hash");