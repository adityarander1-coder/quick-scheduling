-- 006_scheduling.sql — Phase 3: scheduling core.
-- Shift types (per company, with colors), shifts, per-date publish state,
-- day comments, flexible rotations (1–84 day cycles).
-- Runs in filename order via src/db.ts migration runner.

-- Shift types belong to a company. Seeded with hospital defaults on first
-- schedule use; companies can customize names/colors later.
CREATE TABLE IF NOT EXISTS shift_types (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  short_name text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT '#3b82f6',
  text_color text NOT NULL DEFAULT '#ffffff',
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_types_company_id_idx ON shift_types (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS shift_types_company_name_unique
  ON shift_types (company_id, lower(name));

-- Shifts: one row per person per date per shift type.
CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_type_id uuid NOT NULL REFERENCES shift_types(id) ON DELETE RESTRICT,
  date date NOT NULL,
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS shifts_company_date_idx ON shifts (company_id, date);
CREATE INDEX IF NOT EXISTS shifts_user_date_idx ON shifts (user_id, date);

-- Per-date publish state. A date with no row is an unpublished draft.
CREATE TABLE IF NOT EXISTS schedule_days (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date date NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (company_id, date)
);

-- Day comments: per-date notes, optionally about a specific team member.
CREATE TABLE IF NOT EXISTS day_comments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date date NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  comment text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS day_comments_company_date_idx ON day_comments (company_id, date);

-- Rotations: flexible 1–84 day repeating patterns.
CREATE TABLE IF NOT EXISTS rotations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  cycle_days int NOT NULL CHECK (cycle_days BETWEEN 1 AND 84),
  start_date date NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rotations_company_id_idx ON rotations (company_id);

-- Rotation assignments: which user works which shift type on which cycle day.
CREATE TABLE IF NOT EXISTS rotation_assignments (
  id uuid PRIMARY KEY,
  rotation_id uuid NOT NULL REFERENCES rotations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle_day int NOT NULL CHECK (cycle_day >= 1),
  shift_type_id uuid NOT NULL REFERENCES shift_types(id) ON DELETE RESTRICT,
  UNIQUE (rotation_id, user_id, cycle_day, shift_type_id)
);
CREATE INDEX IF NOT EXISTS rotation_assignments_rotation_idx ON rotation_assignments (rotation_id);
