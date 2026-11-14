-- Duplicate memberships first: keep each person's highest role in an org, the oldest row on a tie.
DELETE FROM `member` WHERE `id` NOT IN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (
      PARTITION BY `organization_id`, `user_id`
      ORDER BY CASE `role` WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, `created_at`, `id`
    ) AS `rn` FROM `member`
  ) WHERE `rn` = 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `member_org_user_uq` ON `member` (`organization_id`,`user_id`);
