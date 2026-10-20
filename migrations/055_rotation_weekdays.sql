-- 055_rotation_weekdays.sql
-- Weekly/biweekly rotations can land on several weekdays (e.g. Mon+Thu).
-- recur_days stores comma-separated weekday numbers (0=Sunday .. 6=Saturday).
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS recur_days TEXT;
