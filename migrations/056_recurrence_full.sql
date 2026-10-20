-- 056_recurrence_full.sql
-- Full recurrence: every-N interval and end-after-N-occurrences.
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS recur_interval INT;
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS recur_count INT;
