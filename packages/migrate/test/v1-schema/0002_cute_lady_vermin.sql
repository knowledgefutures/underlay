CREATE TABLE "negotiate_session_manifest" (
	"session_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"type" text NOT NULL,
	"hash" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"needed" boolean DEFAULT true NOT NULL,
	CONSTRAINT "negotiate_session_manifest_session_id_hash_pk" PRIMARY KEY("session_id","hash")
);
--> statement-breakpoint
ALTER TABLE "negotiate_session_manifest" ADD CONSTRAINT "negotiate_session_manifest_session_id_negotiate_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."negotiate_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nsm_session_needed_idx" ON "negotiate_session_manifest" USING btree ("session_id","needed");--> statement-breakpoint
ALTER TABLE "negotiate_sessions" DROP COLUMN "manifest";--> statement-breakpoint
ALTER TABLE "negotiate_sessions" DROP COLUMN "needed_records";