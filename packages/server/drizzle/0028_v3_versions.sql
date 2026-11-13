ALTER TABLE `versions` ADD `asset_bytes` integer;--> statement-breakpoint
ALTER TABLE `versions` ADD `v2_hash` text;--> statement-breakpoint
CREATE INDEX `versions_v2_hash_idx` ON `versions` (`v2_hash`);