-- 054_session_supervisor.sql
-- Sessions get an optional supervisor, picked from the same team roster.
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS supervisor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
