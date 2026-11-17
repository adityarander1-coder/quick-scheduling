-- 112_schedule_history_snapshots.sql — History snapshots (Deepika, 2026-11-17):
-- a safety-net copy of the schedule, view-only, NO restore. A snapshot
-- is saved on every publish, every change to a published shift, and
-- every draft change. Each row is a FROZEN copy of the schedule as it
-- stood at capture time: the stored shifts + drawn rotation
-- occurrences the grid was showing, with names frozen at capture
-- (a later rename never rewrites a copy), plus the open-slot maps and
-- staffing targets so the copy view can recompute opens exactly.
-- department_ids is the set of departments the change touched; the
-- History list and the copy view are scoped on it (a scheduler sees
-- only entries touching a department they can see; an empty set is
-- owner-only). created_date is the date in the company's own timezone
-- (the by-date filter reads this column, not UTC). Last 100 per
-- company are kept; the 101st insert prunes the oldest (done in
-- code, src/util/history.ts).
CREATE TABLE IF NOT EXISTS schedule_history_snapshots (
  id uuid PRIMARY KEY,
  company_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_date date NOT NULL,
  created_by text,
  created_by_name text,
  trigger text NOT NULL CHECK (trigger IN ('publish', 'published-change', 'draft-change')),
  summary text NOT NULL DEFAULT '',
  department_ids text[] NOT NULL DEFAULT '{}',
  window_from date NOT NULL,
  window_to date NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_history_snapshots_company_idx
  ON schedule_history_snapshots (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS schedule_history_snapshots_company_date_idx
  ON schedule_history_snapshots (company_id, created_date, created_at DESC);
