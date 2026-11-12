CREATE TABLE `v3_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`message` text,
	`base` text,
	`app_id` text,
	`files` text,
	`change` text,
	`expect_head` text,
	`schemas` text,
	`verified` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`result` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `v3_uploads_collection_idx` ON `v3_uploads` (`collection_id`);--> statement-breakpoint
CREATE INDEX `v3_uploads_user_status_idx` ON `v3_uploads` (`user_id`,`status`);