-- 003_team.sql — Phase 2: departments, user profile columns, candidates.
-- Runs in filename order via src/db.ts migration runner.

-- Departments belong to a company; names unique per company (case-insensitive).
CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS departments_company_id_idx ON departments (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS departments_company_name_unique
  ON departments (company_id, lower(name));

-- Employee profile columns on users.
-- role (owner/scheduler/employee) is the SYSTEM role and stays separate from
-- job_role (free-text clinical role like 'Day Hospitalist' / 'Night NP').
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_role text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS end_date date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS users_department_id_idx ON users (department_id);

-- Candidate intake queue. Submitted via the public /apply.html form (no login);
-- approved candidates become users with system role 'employee'.
CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  nickname text,
  email text,
  phone text,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  job_role text,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidates_company_id_idx ON candidates (company_id);
CREATE INDEX IF NOT EXISTS candidates_company_status_idx ON candidates (company_id, status);
