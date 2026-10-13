-- 035_job_roles.sql — Job roles per department, member role assignment, and
-- shift-type eligibility lists.
--
-- Permission model: job roles are department-scoped. Schedulers manage roles
-- only in departments where they have Edit access (enforced in the API).
--
-- Eligibility is symmetric/bidirectional: a shift's eligible_job_role_ids is the
-- single gate. A member can pick up an open shift iff the list is empty/NULL
-- (everyone eligible) OR their job_role_id is in the list. Members with no
-- role set can only pick up shifts with no role restriction.

-- Job roles belong to one department of one company. Names unique per
-- department (case-insensitive), e.g. "Physician", "Nurse Practitioner".
CREATE TABLE IF NOT EXISTS job_roles (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_roles_company_id_idx ON job_roles (company_id);
CREATE INDEX IF NOT EXISTS job_roles_department_id_idx ON job_roles (department_id);
CREATE UNIQUE INDEX IF NOT EXISTS job_roles_department_name_unique
  ON job_roles (department_id, lower(name));

-- Team members: link to a job role. The legacy free-text users.job_role is
-- kept and synced to the role name for backward compatibility.
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_role_id uuid
  REFERENCES job_roles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_job_role_id_idx ON users (job_role_id);

-- Shift types: which job roles may pick up this shift's open slots.
-- NULL or empty array = everyone eligible (backward compatible).
ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS eligible_job_role_ids uuid[];

-- Backfill: members whose free-text job_role matches a role name in their
-- department get linked to that role (case-insensitive). Non-matching
-- free-text values are left as-is (no role link).
UPDATE users u
SET job_role_id = jr.id
FROM job_roles jr
WHERE u.job_role_id IS NULL
  AND u.department_id IS NOT NULL
  AND jr.department_id = u.department_id
  AND lower(jr.name) = lower(u.job_role)
  AND u.job_role IS NOT NULL;
