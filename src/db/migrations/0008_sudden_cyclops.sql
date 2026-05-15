ALTER TABLE "password_reset_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "password_reset_tokens" CASCADE;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "kf_org_id" text;--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "email_verified";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_kf_org_id_unique" UNIQUE("kf_org_id");