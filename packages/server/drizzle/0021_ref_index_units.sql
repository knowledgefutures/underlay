CREATE TABLE `ref_index_units` (
	`version_id` text NOT NULL,
	`unit` integer NOT NULL,
	`events` integer NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`version_id`, `unit`)
);
