-- 057_rooms.sql
-- Conference rooms / locations for dashboard sessions, each optionally
-- linked to an external calendar feed (ICS) for availability checks.
CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ics_url TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rooms_company ON rooms(company_id);
