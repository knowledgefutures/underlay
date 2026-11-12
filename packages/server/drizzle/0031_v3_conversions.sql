CREATE TABLE `v3_conversions` (
	`collection_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`flip` integer DEFAULT false NOT NULL,
	`allow_private` integer DEFAULT false NOT NULL,
	`from_layout` text,
	`from_public` integer,
	`from_history_bytes` integer,
	`private` integer DEFAULT false NOT NULL,
	`versions` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
