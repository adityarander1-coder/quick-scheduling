-- Audit log: support settings changes + agent/email sources.
ALTER TABLE schedule_audit_log
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'schedule'
    CHECK (category IN ('schedule', 'settings'));
-- Allow agent/email sources (were added in code before the CHECK was updated).
ALTER TABLE schedule_audit_log DROP CONSTRAINT IF EXISTS schedule_audit_log_source_check;
ALTER TABLE schedule_audit_log
  ADD CONSTRAINT schedule_audit_log_source_check
  CHECK (source IN ('manual', 'rotation', 'agent', 'email'));
CREATE INDEX IF NOT EXISTS idx_audit_company_category_created
  ON schedule_audit_log(company_id, category, created_at DESC);
