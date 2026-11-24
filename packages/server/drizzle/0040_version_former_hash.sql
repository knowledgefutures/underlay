ALTER TABLE `versions` ADD `former_hash` text;--> statement-breakpoint
CREATE INDEX `versions_former_hash_idx` ON `versions` (`former_hash`);