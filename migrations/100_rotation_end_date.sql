-- 100_rotation_end_date.sql
-- A rotation can END (Deepika, 2026-11-09: "Change rotation from a
-- date" + "Swap rotations from a date"). end_date is the rotation's
-- LAST drawn day — the same convention as users.end_date (last
-- working day). NULL = repeats forever, as every rotation did before.
-- The change/swap actions set end_date on the old rotation and start
-- a NEW rotation the next day; the old definition is never mutated,
-- so its past drawing is untouched. Stored shifts are never involved.
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS end_date DATE;
