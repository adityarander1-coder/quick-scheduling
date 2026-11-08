-- 098_institutions.sql — Institutions & branches (Deepika, 2026-11-08):
-- an institution is a parent record linking 2+ companies; each linked
-- company stays the operational unit (departments, people, schedules).
-- Additive only: existing companies default to standalone (no row in
-- institution_branches) and no existing behaviour changes for them.

CREATE TABLE IF NOT EXISTS institutions (
  id uuid PRIMARY KEY,
  legal_name text NOT NULL,
  bill_to text NOT NULL DEFAULT 'parent' CHECK (bill_to IN ('parent', 'branch')),
  ap_email text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institutions_legal_name_idx ON institutions (lower(legal_name));

-- One row per linked company. kind 'main' = the institution's main/HQ
-- branch (its owners are the institution admins); 'branch' = a branch.
-- Declared size is what the branch declared at signup (data only).
CREATE TABLE IF NOT EXISTS institution_branches (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('main', 'branch')),
  declared_departments int,
  declared_employees int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institution_branches_institution_idx ON institution_branches (institution_id);

-- Branch address + timezone live on the company (nullable; only branch
-- companies fill them in this build).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone text;

-- The signup person's title (institutional signup asks for it).
ALTER TABLE users ADD COLUMN IF NOT EXISTS title text;

-- A standalone company (or a joining-fork signup) asks to join an
-- institution by name. institution_id is set when the name matched an
-- institution's legal name; unmatched requests stay institution_id NULL
-- and simply never surface to an admin until a match exists.
CREATE TABLE IF NOT EXISTS institution_join_requests (
  id uuid PRIMARY KEY,
  institution_id uuid REFERENCES institutions(id) ON DELETE CASCADE,
  institution_name text NOT NULL,
  requesting_company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  requester_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requester_email text,
  bill_to text CHECK (bill_to IN ('parent', 'branch')),
  ap_email text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institution_join_requests_institution_idx
  ON institution_join_requests (institution_id, status);
CREATE INDEX IF NOT EXISTS institution_join_requests_company_idx
  ON institution_join_requests (requesting_company_id, status);

-- An institution admin names a new branch and invites its first admin.
-- Accepting the invite creates the branch company (already linked) with
-- the invitee as owner. Only the token's SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS branch_invites (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  branch_name text NOT NULL,
  email text NOT NULL,
  token_hash text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS branch_invites_token_idx ON branch_invites (token_hash);
