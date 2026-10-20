-- Academic dashboard: lecture / teaching sessions whose lecturers are team
-- members from the SAME roster database as the schedule (users table).
CREATE TABLE IF NOT EXISTS academic_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  lecturer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  session_date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'event')),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_academic_sessions_company_date
  ON academic_sessions(company_id, session_date);
