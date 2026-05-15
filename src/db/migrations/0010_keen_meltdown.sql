ALTER TABLE "accounts" DROP CONSTRAINT "accounts_kf_user_id_unique";--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_kf_org_id_unique";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "kf_user_id";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "kf_orgs";