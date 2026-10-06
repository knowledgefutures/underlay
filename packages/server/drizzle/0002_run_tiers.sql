ALTER TABLE `push_runs` ADD `tier` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `push_runs` ADD `merging_into` integer;--> statement-breakpoint
CREATE INDEX `push_runs_tier_idx` ON `push_runs` (`session_id`,`tier`,`merging_into`);