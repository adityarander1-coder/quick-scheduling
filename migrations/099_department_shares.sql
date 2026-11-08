-- 099_department_shares.sql
-- Shared departments across branches of one institution (Deepika,
-- 2026-11-08, phase 3 of the institution build): the OWNING branch
-- offers a department to a named sibling branch; the receiving branch
-- pulls. A share is per-department, view-only or cover-enabled, and
-- revocable (revoked_at set; the row stays for history).
--
-- Cross-branch assignments are the "pickable" form this build ships:
-- shifts.user_id must reference a user of the SAME company, so a person
-- from Branch A cannot be written onto a Branch B shift row without
-- deep surgery. Instead, picking A's person for B's shift creates a
-- PENDING cross-branch assignment the person confirms (bell + email,
-- token act page like the gap offers). Confirmed assignments render in
-- B's on-call strip and reports read them from this table. The
-- cross-branch identity key is the person's EMAIL (documented in
-- util/institutions.ts): a human with accounts in both branches is
-- matched by email for the dual conflict check.

CREATE TABLE IF NOT EXISTS department_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id),
  from_company_id UUID NOT NULL REFERENCES companies(id),
  department_id UUID NOT NULL REFERENCES departments(id),
  to_company_id UUID NOT NULL REFERENCES companies(id),
  mode TEXT NOT NULL DEFAULT 'view' CHECK (mode IN ('view', 'cover')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
-- One ACTIVE share per (department, receiving branch).
CREATE UNIQUE INDEX IF NOT EXISTS department_shares_active_uniq
  ON department_shares (department_id, to_company_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS department_shares_to_idx
  ON department_shares (to_company_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS department_shares_from_idx
  ON department_shares (from_company_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cross_branch_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL REFERENCES department_shares(id),
  host_company_id UUID NOT NULL REFERENCES companies(id),      -- Branch B (the shift lives here)
  home_company_id UUID NOT NULL REFERENCES companies(id),      -- Branch A (the person's home)
  home_user_id UUID NOT NULL REFERENCES users(id),             -- the person, in Branch A
  host_shift_type_id UUID NOT NULL REFERENCES shift_types(id), -- Branch B's shift type
  host_department_id UUID REFERENCES departments(id),          -- Branch B department context, if any
  date DATE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'assign' CHECK (kind IN ('cover', 'assign')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled')),
  token TEXT UNIQUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS xbranch_host_idx
  ON cross_branch_assignments (host_company_id, date);
CREATE INDEX IF NOT EXISTS xbranch_home_user_idx
  ON cross_branch_assignments (home_user_id, date);
