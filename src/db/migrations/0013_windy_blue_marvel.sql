CREATE TABLE "metadata_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"user_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"base_semver" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "metadata_jobs" ADD CONSTRAINT "metadata_jobs_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_jobs" ADD CONSTRAINT "metadata_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metadata_jobs_collection_status_idx" ON "metadata_jobs" USING btree ("collection_id","status");