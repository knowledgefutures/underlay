CREATE TABLE `commit_units` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`set` text NOT NULL,
	`type` text NOT NULL,
	`ord` integer NOT NULL,
	`after` text,
	`through` text,
	`gap` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`slices_key` text,
	`output_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `push_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commit_units_plan_idx` ON `commit_units` (`plan_id`,`set`,`type`,`ord`);--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `commit_plan` text;--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `assembly_lease` integer;