-- 053_session_recurrence.sql
-- Recurring sessions/events on dashboards: weekly or every-two-weeks series.
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS recur_rule TEXT DEFAULT 'none';
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS recur_until DATE;
