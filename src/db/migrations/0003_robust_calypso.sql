CREATE TABLE "record_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_types_collection_id_slug_unique" UNIQUE("collection_id","slug")
);
--> statement-breakpoint
CREATE TABLE "version_record_types" (
	"version_id" bigint NOT NULL,
	"record_type_id" uuid NOT NULL,
	"source_version_id" bigint,
	CONSTRAINT "version_record_types_version_id_record_type_id_pk" PRIMARY KEY("version_id","record_type_id")
);
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "record_type_id" uuid;--> statement-breakpoint
ALTER TABLE "record_types" ADD CONSTRAINT "record_types_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_record_types" ADD CONSTRAINT "version_record_types_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_record_types" ADD CONSTRAINT "version_record_types_record_type_id_record_types_id_fk" FOREIGN KEY ("record_type_id") REFERENCES "public"."record_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_record_types" ADD CONSTRAINT "version_record_types_source_version_id_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_record_type_id_record_types_id_fk" FOREIGN KEY ("record_type_id") REFERENCES "public"."record_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "records_record_type_idx" ON "records" ("record_type_id");--> statement-breakpoint
CREATE INDEX "version_record_types_version_idx" ON "version_record_types" ("version_id");--> statement-breakpoint
CREATE INDEX "version_record_types_source_idx" ON "version_record_types" ("source_version_id");