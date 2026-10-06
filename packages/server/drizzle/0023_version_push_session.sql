ALTER TABLE `versions` ADD `push_session_id` text;--> statement-breakpoint
CREATE INDEX `versions_push_session_idx` ON `versions` (`push_session_id`);