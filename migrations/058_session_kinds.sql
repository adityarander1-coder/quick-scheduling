-- 058_session_kinds.sql
-- Company-defined session kinds (Lecture / Event built in; owners can
-- add their own, e.g. Interviews) + a meeting link (Zoom / Teams) on
-- each session.
CREATE TABLE IF NOT EXISTS session_kinds (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#00796b',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);
CREATE INDEX IF NOT EXISTS idx_session_kinds_company ON session_kinds(company_id);

ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS meeting_url TEXT;

-- Migration 051 constrained kind to ('session','event'); kinds are
-- company-defined now and validated by the API, so the check goes.
ALTER TABLE academic_sessions DROP CONSTRAINT IF EXISTS academic_sessions_kind_check;

-- Seed the two built-in kinds for every existing company (keys match
-- the values sessions already store: 'session' = Lecture, 'event').
INSERT INTO session_kinds (id, company_id, key, label, color, position)
SELECT gen_random_uuid(), c.id, 'session', 'Lecture', '#00796b', 0 FROM companies c
ON CONFLICT (company_id, key) DO NOTHING;
INSERT INTO session_kinds (id, company_id, key, label, color, position)
SELECT gen_random_uuid(), c.id, 'event', 'Event', '#7c3aed', 1 FROM companies c
ON CONFLICT (company_id, key) DO NOTHING;
