CREATE TABLE `push_packs` (
	`session_id` text NOT NULL,
	`pack_id` text NOT NULL,
	`record_set` text NOT NULL,
	`records` integer,
	`bytes` integer,
	`raw` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`session_id`, `pack_id`),
	FOREIGN KEY (`session_id`) REFERENCES `push_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `commit_started` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `in_key_order` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `overlapping_uploads` integer DEFAULT 0 NOT NULL;