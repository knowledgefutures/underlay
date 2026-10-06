-- The deployment's own storage location. Its bucket and credentials come from
-- the deployment's bindings and secrets, not from this row.
INSERT INTO `storage_locations` (`id`, `organization_id`, `kind`, `name`, `prefix`, `permissions`, `status`)
VALUES ('platform', NULL, 'platform', 'Underlay', '', 'read_write', 'active');
