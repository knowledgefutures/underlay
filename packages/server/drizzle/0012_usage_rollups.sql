CREATE TABLE `usage_rollups` (
	`day` text NOT NULL,
	`account_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`metric` text NOT NULL,
	`amount` integer NOT NULL,
	PRIMARY KEY(`day`, `account_id`, `collection_id`, `metric`)
);
--> statement-breakpoint
CREATE INDEX `usage_rollups_account_idx` ON `usage_rollups` (`account_id`,`day`);