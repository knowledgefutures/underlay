ALTER TABLE `collection_tombstones` ADD `record_layout` text DEFAULT 'today' NOT NULL;--> statement-breakpoint
ALTER TABLE `collection_tombstones` ADD `records_dropped_at` integer;--> statement-breakpoint
ALTER TABLE `collections` ADD `record_layout` text DEFAULT 'today' NOT NULL;