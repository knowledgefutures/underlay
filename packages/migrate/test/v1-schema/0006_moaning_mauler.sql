CREATE TABLE "collection_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"url" text NOT NULL,
	"bump_filter" text[] DEFAULT '{major,minor,patch}'::text[] NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivery_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"version_id" bigint,
	"semver" text,
	"bump_type" text NOT NULL,
	"event" text DEFAULT 'version.created' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_code" integer,
	"error" text,
	"duration_ms" integer,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "collection_webhooks" ADD CONSTRAINT "collection_webhooks_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_webhooks" ADD CONSTRAINT "collection_webhooks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_collection_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."collection_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_webhooks_collection_id_idx" ON "collection_webhooks" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_collection_id_idx" ON "webhook_deliveries" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_sweep_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");