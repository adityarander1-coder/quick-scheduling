-- 036_plan_partial_status.sql — allow 'partial' status on schedule_plans.
-- Plans where some changes applied and others failed are marked 'partial'
-- (with executed_at set) instead of 'approved', so the failure is visible
-- and the plan can be retried or fixed by the scheduler.
--
-- The original CHECK was created inline by 027_schedule_plans.sql, so
-- Postgres auto-named it schedule_plans_status_check.

ALTER TABLE schedule_plans DROP CONSTRAINT IF EXISTS schedule_plans_status_check;

ALTER TABLE schedule_plans
  ADD CONSTRAINT schedule_plans_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'partial'));
