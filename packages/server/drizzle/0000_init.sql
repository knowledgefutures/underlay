CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer DEFAULT 86400000,
	`rate_limit_max` integer DEFAULT 10,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE INDEX `apikey_reference_id_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE TABLE `ark_collections` (
	`collection_id` text PRIMARY KEY NOT NULL,
	`ark_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`custom_url` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ark_collections_ark_id_unique` ON `ark_collections` (`ark_id`);--> statement-breakpoint
CREATE TABLE `ark_record_types` (
	`collection_id` text NOT NULL,
	`record_type` text NOT NULL,
	`redirect_url_field` text NOT NULL,
	PRIMARY KEY(`collection_id`, `record_type`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ark_shoulders` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`shoulder` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ark_shoulders_shoulder_unique` ON `ark_shoulders` (`shoulder`);--> statement-breakpoint
CREATE TABLE `collection_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`url` text NOT NULL,
	`bump_filter` text DEFAULT 'all' NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`last_delivery_at` integer,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collection_webhooks_collection_idx` ON `collection_webhooks` (`collection_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`head_version_id` text,
	`private_salt` text NOT NULL,
	`public_files_root` text,
	`summary` text,
	`ref_events` integer DEFAULT 0 NOT NULL,
	`ref_bytes` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_org_slug_uq` ON `collections` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `collections_public_updated_idx` ON `collections` (`public`,`updated_at`);--> statement-breakpoint
CREATE TABLE `denylist` (
	`hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`session_id` text,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`storage_key` text NOT NULL,
	`multipart_upload_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `file_uploads_hash_idx` ON `file_uploads` (`hash`);--> statement-breakpoint
CREATE TABLE `files` (
	`hash` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`storage_key` text NOT NULL,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `forks` (
	`child_collection_id` text PRIMARY KEY NOT NULL,
	`parent_collection_id` text NOT NULL,
	`parent_seq` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`child_collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitation_organization_id_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL,
	`locked_until` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_ready_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `legacy_hashes` (
	`legacy_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_organization_id_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_user_id_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`metadata` text,
	`bio` text,
	`website` text,
	`avatar_url` text,
	`ark_naan` text,
	`kf_org_id` text,
	`is_default` integer DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE `page_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`page` text NOT NULL,
	`anchor` text NOT NULL,
	`quote` text,
	`quote_context` text,
	`parent_id` text,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`approved_at` integer,
	`approved_by` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution_note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`edited_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `page_comments_page_idx` ON `page_comments` (`page`);--> statement-breakpoint
CREATE TABLE `placements` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text,
	`organization_id` text,
	`location_id` text NOT NULL,
	`role` text NOT NULL,
	`sets` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`synced_seq` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `storage_locations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placements_one_primary_uq` ON `placements` (`collection_id`) WHERE "placements"."role" = 'primary' AND "placements"."collection_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `placements_target_location_uq` ON `placements` (`collection_id`,`organization_id`,`location_id`);--> statement-breakpoint
CREATE INDEX `placements_location_idx` ON `placements` (`location_id`);--> statement-breakpoint
CREATE TABLE `push_runs` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`count` integer NOT NULL,
	`first_key` text NOT NULL,
	`last_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`session_id`, `seq`),
	FOREIGN KEY (`session_id`) REFERENCES `push_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`base_version_id` text,
	`base_semver` text,
	`message` text,
	`app_id` text,
	`actor_id` text,
	`strip_unknown_fields` integer DEFAULT false NOT NULL,
	`manifest_expected` integer,
	`manifest_received` integer DEFAULT 0 NOT NULL,
	`manifest_needed` integer DEFAULT 0 NOT NULL,
	`records_received` integer DEFAULT 0 NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`result` text,
	`error` text,
	`finalize_started_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `push_sessions_collection_idx` ON `push_sessions` (`collection_id`);--> statement-breakpoint
CREATE INDEX `push_sessions_expires_idx` ON `push_sessions` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `schema_labels` (
	`schema_hash` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`schema_hash`, `label`)
);
--> statement-breakpoint
CREATE INDEX `schema_labels_label_idx` ON `schema_labels` (`label`);--> statement-breakpoint
CREATE TABLE `schema_usage` (
	`schema_hash` text NOT NULL,
	`collection_id` text NOT NULL,
	`type_slug` text NOT NULL,
	`set` text NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer,
	PRIMARY KEY(`collection_id`, `type_slug`, `set`, `from_seq`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schema_usage_hash_idx` ON `schema_usage` (`schema_hash`);--> statement-breakpoint
CREATE TABLE `schemas` (
	`hash` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`active_organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `storage_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`endpoint` text,
	`region` text,
	`bucket` text,
	`prefix` text DEFAULT '' NOT NULL,
	`credentials` text,
	`permissions` text NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`last_error` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`seq` integer NOT NULL,
	`semver` text NOT NULL,
	`major` integer NOT NULL,
	`minor` integer NOT NULL,
	`patch` integer NOT NULL,
	`hash` text NOT NULL,
	`legacy_hash` text,
	`legacy_public_hash` text,
	`base_semver` text,
	`message` text,
	`pushed_by` text,
	`app_id` text,
	`actor_id` text,
	`signature` text,
	`record_count` integer NOT NULL,
	`public_record_count` integer NOT NULL,
	`file_count` integer NOT NULL,
	`total_bytes` integer NOT NULL,
	`type_counts` text NOT NULL,
	`public_type_counts` text NOT NULL,
	`has_private` integer DEFAULT false NOT NULL,
	`changes` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `versions_collection_seq_uq` ON `versions` (`collection_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `versions_collection_semver_uq` ON `versions` (`collection_id`,`semver`);--> statement-breakpoint
CREATE INDEX `versions_hash_idx` ON `versions` (`hash`);--> statement-breakpoint
CREATE INDEX `versions_legacy_hash_idx` ON `versions` (`legacy_hash`);--> statement-breakpoint
CREATE INDEX `versions_legacy_public_hash_idx` ON `versions` (`legacy_public_hash`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`version_id` text,
	`semver` text,
	`bump_type` text NOT NULL,
	`event` text DEFAULT 'version.created' NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`response_code` integer,
	`error` text,
	`duration_ms` integer,
	`next_attempt_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`webhook_id`) REFERENCES `collection_webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_pending_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);