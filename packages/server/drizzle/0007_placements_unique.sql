DROP INDEX `placements_target_location_uq`;--> statement-breakpoint
-- The old index never fired (NULLs are distinct), so duplicates may exist: keep the oldest row.
DELETE FROM `placements` WHERE `collection_id` IS NOT NULL AND rowid NOT IN (SELECT MIN(rowid) FROM `placements` WHERE `collection_id` IS NOT NULL GROUP BY `collection_id`, `location_id`);--> statement-breakpoint
DELETE FROM `placements` WHERE `organization_id` IS NOT NULL AND rowid NOT IN (SELECT MIN(rowid) FROM `placements` WHERE `organization_id` IS NOT NULL GROUP BY `organization_id`, `location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placements_collection_location_uq` ON `placements` (`collection_id`,`location_id`) WHERE "placements"."collection_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `placements_org_location_uq` ON `placements` (`organization_id`,`location_id`) WHERE "placements"."organization_id" IS NOT NULL;
