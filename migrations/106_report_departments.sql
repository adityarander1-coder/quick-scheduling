-- Report redesign, follow-up (Deepika, 2026-11-13): the Change report
-- must be department-scoped — an admin sees updates for the departments
-- they have access to; an owner sees all. Rows that cannot be
-- attributed to a department stay visible to the owner only.
-- department_id is the PRIMARY attribution, written by auditLog going
-- forward: an explicit department (department-management changes), else
-- the affected person's home department, else the single department of
-- the rotation / shift type involved. The endpoint also derives the
-- full relevant-department set at read time (person + shift type +
-- rotation) for the visibility check.
ALTER TABLE schedule_audit_log
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_audit_company_dept_created
  ON schedule_audit_log(company_id, department_id, created_at DESC);
-- Backfill where derivable: the affected person's home department, or
-- an explicit department recorded in details. Rows that stay NULL
-- (whole-date publishes, rotation rows with no person, pre-fix rows
-- with no ids) remain owner-only.
UPDATE schedule_audit_log a
  SET department_id = u.department_id
  FROM users u
  WHERE a.affected_user_id = u.id AND u.department_id IS NOT NULL
    AND a.department_id IS NULL;
UPDATE schedule_audit_log
  SET department_id = (details->>'departmentId')::uuid
  WHERE details ? 'departmentId'
    AND (details->>'departmentId') ~ '^[0-9a-fA-F-]{36}$'
    AND EXISTS (SELECT 1 FROM departments WHERE id = (details->>'departmentId')::uuid)
    AND department_id IS NULL;
