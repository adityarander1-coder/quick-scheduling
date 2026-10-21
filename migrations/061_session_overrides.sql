-- 061_session_overrides.sql
-- Per-date individualization for recurring sessions (Deepika,
-- 2026-10-20): a series keeps the defaults, but any single date can
-- have its own presenter, supervisor, location, meeting link or
-- times — or be cancelled on its own (holidays). The has_* flags
-- distinguish "this date sets the field (possibly to nobody/nothing)"
-- from "no override — follow the series".
CREATE TABLE IF NOT EXISTS academic_session_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  lecturer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  supervisor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  location TEXT,
  meeting_url TEXT,
  start_time TIME,
  end_time TIME,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  has_lecturer BOOLEAN NOT NULL DEFAULT false,
  has_supervisor BOOLEAN NOT NULL DEFAULT false,
  has_location BOOLEAN NOT NULL DEFAULT false,
  has_meeting_url BOOLEAN NOT NULL DEFAULT false,
  has_times BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, date)
);
CREATE INDEX IF NOT EXISTS idx_session_overrides_company ON academic_session_overrides(company_id, session_id);
