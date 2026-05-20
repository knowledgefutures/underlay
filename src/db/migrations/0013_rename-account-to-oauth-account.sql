-- Rename better-auth's "account" table to "oauth_account" to avoid confusion with our "accounts" table.
-- This is a no-op if the table was already created as "oauth_account" (fresh installs).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'account' AND table_schema = 'public') THEN
    ALTER TABLE "account" RENAME TO "oauth_account";
    ALTER TABLE "oauth_account" RENAME CONSTRAINT "account_user_id_user_id_fk" TO "oauth_account_user_id_user_id_fk";
  END IF;
END $$;
