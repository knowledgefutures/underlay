ALTER TABLE "accounts" ADD COLUMN "ark_naan" text;--> statement-breakpoint
CREATE TABLE "ark_shoulders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"shoulder" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ark_shoulders_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "ark_shoulders_shoulder_unique" UNIQUE("shoulder")
);
--> statement-breakpoint
CREATE TABLE "ark_collections" (
	"collection_id" uuid PRIMARY KEY NOT NULL,
	"ark_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"custom_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ark_collections_ark_id_unique" UNIQUE("ark_id")
);
--> statement-breakpoint
CREATE TABLE "ark_record_types" (
	"collection_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"redirect_url_field" text NOT NULL,
	CONSTRAINT "ark_record_types_collection_id_record_type_pk" PRIMARY KEY("collection_id","record_type")
);
--> statement-breakpoint
ALTER TABLE "ark_shoulders" ADD CONSTRAINT "ark_shoulders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ark_collections" ADD CONSTRAINT "ark_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ark_record_types" ADD CONSTRAINT "ark_record_types_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
