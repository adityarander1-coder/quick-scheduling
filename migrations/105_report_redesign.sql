-- Report redesign (Deepika, 2026-11-13): the Change report needs an
-- affected person id, a result, a schedule-date range, and a 'code'
-- source for code-caused side effects (drafts that appear after a
-- removal). Existing rows keep working: result defaults to
-- 'successful', schedule_date backfills from the row's date for
-- schedule rows, and bulk-publish rows take their range from
-- details.from/to.
ALTER TABLE schedule_audit_log
  ADD COLUMN IF NOT EXISTS affected_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS result text NOT NULL DEFAULT 'successful'
    CHECK (result IN ('successful', 'not_successful')),
  ADD COLUMN IF NOT EXISTS schedule_date date,
  ADD COLUMN IF NOT EXISTS schedule_date_end date;
ALTER TABLE schedule_audit_log DROP CONSTRAINT IF EXISTS schedule_audit_log_source_check;
ALTER TABLE schedule_audit_log
  ADD CONSTRAINT schedule_audit_log_source_check
  CHECK (source IN ('manual', 'rotation', 'agent', 'email', 'code'));
UPDATE schedule_audit_log SET schedule_date = date
  WHERE category = 'schedule' AND schedule_date IS NULL;
UPDATE schedule_audit_log
  SET schedule_date = (details->>'from')::date,
      schedule_date_end = (details->>'to')::date
  WHERE details ? 'batchId' AND action = 'published'
    AND (details->>'from') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (details->>'to') ~ '^\d{4}-\d{2}-\d{2}$';
CREATE INDEX IF NOT EXISTS idx_audit_company_created_desc
  ON schedule_audit_log(company_id, created_at DESC);
