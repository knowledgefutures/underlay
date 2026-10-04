CREATE TABLE `cleanup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`step` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`requested_by` text,
	`mark_run_id` text,
	`state` text,
	`stats` text,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cleanup_runs_created_idx` ON `cleanup_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `cleanup_runs_step_idx` ON `cleanup_runs` (`step`,`status`);--> statement-breakpoint
CREATE TABLE `storage_fence` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`window_until` integer,
	`window_run_id` text
);
--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `cleaned_at` integer;--> statement-breakpoint
-- The write fence's one row (cleanup/fence.ts).
INSERT INTO `storage_fence` (`id`, `epoch`) VALUES (1, 0);
