-- 117: Cross-department pull (Deepika, 2026-11-19 — "pull person into
-- the department like adding a new one at the same time they dont have
-- two accounts").
--
-- One account, several departments: a team member's HOME department and
-- job role stay on the users row (department_id / job_role_id — the
-- source of truth for the primary membership, and every existing read
-- keeps working for single-department members). A pull adds a SECONDARY
-- membership here: the same user, a second department, and a NEW job
-- role in that department (the old role never carries over — roles are
-- per-department, and the new role is what makes them compliant with the
-- target department's shift types).
--
-- A person's departments are therefore home ∪ memberships; the role that
-- applies in a department is the membership's role there, else the home
-- role when that department is home. Reads that must see multi-department
-- membership (team list, scheduler user-list scoping, eligibility,
-- rotation relevance, Ask team list, setup counts) union this table;
-- everything else keeps reading the home columns.
CREATE TABLE IF NOT EXISTS user_department_memberships (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  job_role_id uuid REFERENCES job_roles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, department_id)
);
CREATE INDEX IF NOT EXISTS user_department_memberships_user_idx
  ON user_department_memberships (user_id);
CREATE INDEX IF NOT EXISTS user_department_memberships_department_idx
  ON user_department_memberships (department_id);
