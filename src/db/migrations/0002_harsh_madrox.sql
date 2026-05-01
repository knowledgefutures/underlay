CREATE TABLE "upload_records" (
	"session_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"type" text,
	"data" jsonb,
	"private" boolean DEFAULT false,
	"operation" text NOT NULL,
	CONSTRAINT "upload_records_session_id_record_id_pk" PRIMARY KEY("session_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"base_version" integer,
	"message" text,
	"readme" text,
	"app_id" text,
	"actor_id" text,
	"schemas" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_records" ADD CONSTRAINT "upload_records_session_id_upload_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;