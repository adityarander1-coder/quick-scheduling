-- 060_dashboard_editors.sql
-- Per-dashboard editors (Deepika, 2026-10-20): a dashboard can be
-- visible to everyone while only chosen schedulers may adjust its
-- sessions. When a dashboard has editors, the list replaces the
-- department-edit rule for that dashboard's sessions and kinds.
-- No editors = the department-edit rule, as before.
CREATE TABLE IF NOT EXISTS dashboard_editors (
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (dashboard_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dashboard_editors_dash ON dashboard_editors(dashboard_id);
