-- 114: department access requests (Deepika, 2026-11-17).
-- A new "Access" tool in the Tools rail lets a signed-in person ask for
-- access to a department they cannot see yet — view-only for the whole
-- department, or admin (edit) access — for themselves. The admins of
-- that department (edit access) plus the company owner decide; the
-- FIRST approver to act decides, following the dashboard-delete
-- approval-request pattern (migration 090). Approval grants the access
-- immediately via the existing scheduler_department_access table
-- (migration 033); rejection grants nothing. No parallel access system.
CREATE TABLE IF NOT EXISTS department_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('view', 'edit')),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
-- At most ONE pending request per person per department.
CREATE UNIQUE INDEX IF NOT EXISTS department_access_requests_one_pending
  ON department_access_requests (requested_by, department_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS department_access_requests_company_idx
  ON department_access_requests (company_id, status);
CREATE INDEX IF NOT EXISTS department_access_requests_department_idx
  ON department_access_requests (department_id, status);
