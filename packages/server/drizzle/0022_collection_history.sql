ALTER TABLE `collections` ADD `version_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD `history_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD `last_push_at` integer;--> statement-breakpoint
-- Backfill from the versions each collection already has.
UPDATE `collections` SET
  `version_count` = (SELECT count(*) FROM `versions` v WHERE v.`collection_id` = `collections`.`id`),
  `history_bytes` = (SELECT coalesce(sum(v.`total_bytes`), 0) FROM `versions` v WHERE v.`collection_id` = `collections`.`id`),
  `last_push_at` = (SELECT max(v.`created_at`) FROM `versions` v WHERE v.`collection_id` = `collections`.`id`);
