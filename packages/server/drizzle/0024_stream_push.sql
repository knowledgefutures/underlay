ALTER TABLE `commit_units` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `push_runs` ADD `bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `push_runs` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `commit_phase` text;--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `progress_at` integer;--> statement-breakpoint
ALTER TABLE `push_sessions` ADD `stalls` integer DEFAULT 0 NOT NULL;