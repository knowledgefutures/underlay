CREATE TABLE "page_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page" text NOT NULL,
	"anchor" text NOT NULL,
	"quote" text,
	"quote_context" jsonb,
	"parent_id" uuid,
	"user_id" text NOT NULL,
	"body" text NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_comments_page_anchor_idx" ON "page_comments" USING btree ("page","anchor");--> statement-breakpoint
CREATE INDEX "page_comments_user_id_idx" ON "page_comments" USING btree ("user_id");