-- 073_plan_undo.sql — Ctrl+Z for approved tasks (Deepika 2026-11-01).
-- When a plan is approved and executed, the executor's exact before/after
-- row changes are stored on the plan (undo_payload). Ctrl+Z replays the
-- inverse — but only while nothing the task touched has changed since.
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS undo_payload JSONB;
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ;
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS undone_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE schedule_plans DROP CONSTRAINT IF EXISTS schedule_plans_status_check;
ALTER TABLE schedule_plans
  ADD CONSTRAINT schedule_plans_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'partial', 'awaiting_partner', 'undone'));
