ALTER TABLE `collections` ADD `reconcile_state` text;--> statement-breakpoint
ALTER TABLE `collections` ADD `reconciled_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD `reconciled_files_root` text;