-- 089: per-session person-label override (Deepika, 2026-11-07).
-- The people slot on a session is called whatever its TYPE says
-- (session_kinds.person_label, migration 080), defaulting to
-- "Speaker". A session may carry its own name for the slot instead
-- (e.g. one interview session renamed "Panelist" while other
-- interviews stay "Interviewer"). NULL = follow the type.
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS person_label TEXT;
