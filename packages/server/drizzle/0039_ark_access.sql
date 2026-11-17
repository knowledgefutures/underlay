CREATE TABLE `ark_tombstones` (
	`ark_id` text PRIMARY KEY NOT NULL,
	`shoulder` text NOT NULL,
	`naan` text NOT NULL,
	`collection_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`owner_name` text NOT NULL,
	`collection_name` text NOT NULL,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `organization` ADD `ark_kf_naan` integer DEFAULT false NOT NULL;