CREATE TABLE `restores` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text NOT NULL,
	`source_collection_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`sets` text NOT NULL,
	`trust_key_ids` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`restored_seq` integer DEFAULT 0 NOT NULL,
	`last_entry_hash` text,
	`last_version_hash` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `storage_locations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
