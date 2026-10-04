ALTER TABLE "negotiate_sessions" ADD COLUMN "manifest_received" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "negotiate_sessions" ADD COLUMN "manifest_needed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "negotiate_sessions" s SET "manifest_received" = m."total", "manifest_needed" = m."needed" FROM (SELECT "session_id", count(*)::int AS "total", (count(*) FILTER (WHERE "needed"))::int AS "needed" FROM "negotiate_session_manifest" GROUP BY "session_id") m WHERE m."session_id" = s."id";
