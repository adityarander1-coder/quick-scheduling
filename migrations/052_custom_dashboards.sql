-- 052_custom_dashboards.sql
-- Custom dashboards (Option 1: named calendar dashboards created in Settings).
-- Each dashboard gets its own nav tab showing a Day/Week/Month calendar of
-- sessions. Sessions live in academic_sessions with an optional dashboard_id;
-- a dashboard with no dashboard_departments rows shows sessions from all
-- departments (subject to the viewer's role-based department access).

CREATE TABLE IF NOT EXISTS dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboards_company_idx ON dashboards(company_id);

CREATE TABLE IF NOT EXISTS dashboard_departments (
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (dashboard_id, department_id)
);

ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS dashboard_id UUID REFERENCES dashboards(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS academic_sessions_dashboard_idx ON academic_sessions(dashboard_id);

-- Backfill: every company that has academic sessions (or not) gets a default
-- "Academic" dashboard, and its existing sessions are assigned to it.
DO $$
DECLARE r RECORD;
    d_id UUID;
BEGIN
  FOR r IN SELECT id FROM companies LOOP
    SELECT id INTO d_id FROM dashboards WHERE company_id = r.id AND name = 'Academic' LIMIT 1;
    IF d_id IS NULL THEN
      INSERT INTO dashboards (company_id, name) VALUES (r.id, 'Academic') RETURNING id INTO d_id;
    END IF;
    UPDATE academic_sessions SET dashboard_id = d_id WHERE company_id = r.id AND dashboard_id IS NULL;
  END LOOP;
END $$;
