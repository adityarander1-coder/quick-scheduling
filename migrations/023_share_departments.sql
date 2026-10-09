-- Allow multiple schedule share links per company, optionally scoped to a department.
ALTER TABLE schedule_shares ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE CASCADE;
ALTER TABLE schedule_shares ADD COLUMN IF NOT EXISTS label TEXT;
