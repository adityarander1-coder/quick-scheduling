-- 123_remove_autofill_live_modes.sql — Remove "Fill it in automatically"
-- (Deepika, 2026-11-26): every department moves to "Draft from my
-- rotations". All existing 'live' department-mode rows become
-- 'generated'. The 'live' mode value and its code paths stay in the
-- codebase, unused and marked kept-for-restore — this migration only
-- moves the data, so the setting can come back with a small change.
UPDATE department_schedule_modes SET mode = 'generated' WHERE mode = 'live';
