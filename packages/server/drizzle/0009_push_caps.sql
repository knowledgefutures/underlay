ALTER TABLE `commit_units` ADD `queued_at` integer;--> statement-breakpoint
CREATE INDEX `commit_units_status_idx` ON `commit_units` (`session_id`,`status`,`queued_at`);--> statement-breakpoint
CREATE INDEX `push_sessions_user_idx` ON `push_sessions` (`user_id`,`status`);