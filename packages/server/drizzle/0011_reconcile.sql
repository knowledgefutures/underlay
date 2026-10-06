ALTER TABLE `collections` ADD `reconcile_started_at` integer;--> statement-breakpoint
ALTER TABLE `collections` ADD `reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `collections` ADD `reconcile_report` text;--> statement-breakpoint
ALTER TABLE `versions` ADD `ref_events` integer;--> statement-breakpoint
ALTER TABLE `versions` ADD `ref_bytes` integer;--> statement-breakpoint
ALTER TABLE `versions` ADD `reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `versions` ADD `reconcile_report` text;