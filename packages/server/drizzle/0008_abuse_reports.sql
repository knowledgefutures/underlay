CREATE TABLE `abuse_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text,
	`url` text,
	`reason` text NOT NULL,
	`contact` text,
	`reporter_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `abuse_reports_status_idx` ON `abuse_reports` (`status`,`created_at`);