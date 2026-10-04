-- Every deleted collection gets a tombstone, however its row goes: the delete
-- route writes a full one first (this then does nothing), and a cascade from a
-- deleted org or account gets one here. Storage cleanup keeps a tombstoned
-- collection's objects through its grace period, and reference-log compaction
-- drops its events.
CREATE TRIGGER IF NOT EXISTS `collections_tombstone` BEFORE DELETE ON `collections`
BEGIN
  INSERT OR IGNORE INTO `collection_tombstones`
    (`collection_id`, `organization_id`, `slug`, `ref_events`, `ref_bytes`, `versions`,
     `total_bytes`, `deleted_by`, `deleted_at`)
  VALUES (
    OLD.`id`, OLD.`organization_id`, OLD.`slug`, OLD.`ref_events`, OLD.`ref_bytes`,
    (SELECT count(*) FROM `versions` WHERE `collection_id` = OLD.`id`),
    (SELECT coalesce(sum(`total_bytes`), 0) FROM `versions` WHERE `collection_id` = OLD.`id`),
    NULL,
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  );
END;
