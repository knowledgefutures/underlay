CREATE TABLE "schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"version_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"schema" jsonb NOT NULL,
	"schema_hash" text NOT NULL,
	"source_schema_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schemas_collection_id_version_id_slug_unique" UNIQUE("collection_id","version_id","slug")
);
--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_source_schema_id_schemas_id_fk" FOREIGN KEY ("source_schema_id") REFERENCES "public"."schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schemas_schema_hash_idx" ON "schemas" USING btree ("schema_hash");--> statement-breakpoint
CREATE INDEX "schemas_slug_idx" ON "schemas" USING btree ("slug");
