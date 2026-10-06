DROP TABLE `legacy_hashes`;--> statement-breakpoint
DROP INDEX `versions_legacy_hash_idx`;--> statement-breakpoint
DROP INDEX `versions_legacy_public_hash_idx`;--> statement-breakpoint
ALTER TABLE `versions` DROP COLUMN `legacy_hash`;--> statement-breakpoint
ALTER TABLE `versions` DROP COLUMN `legacy_public_hash`;