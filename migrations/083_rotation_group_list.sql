-- 083_rotation_group_list.sql
-- A group rotation can rotate through SEVERAL groups in order
-- (Deepika 2026-11-04 evening): each turn block goes to the next
-- group, and inside a group the next member in its fixed order takes
-- that group's turns. group_ids is the ordered comma-separated list;
-- group_id keeps holding the first group for older reads.
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS group_ids text;
UPDATE rotations SET group_ids = group_id::text WHERE group_id IS NOT NULL AND group_ids IS NULL;
