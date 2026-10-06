CREATE TABLE `collection_tombstones` (
	`collection_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`ref_events` integer NOT NULL,
	`ref_bytes` integer NOT NULL,
	`versions` integer NOT NULL,
	`total_bytes` integer NOT NULL,
	`deleted_by` text,
	`deleted_at` integer NOT NULL
);
