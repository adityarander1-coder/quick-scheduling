-- Rotation pause periods: multiple date ranges per rotation (e.g., vacations).
-- Rotation shifts are not generated for dates within a pause period.
CREATE TABLE IF NOT EXISTS rotation_pauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rotation_id UUID NOT NULL REFERENCES rotations(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_rotpauses_rotation ON rotation_pauses(rotation_id);
CREATE INDEX IF NOT EXISTS idx_rotpauses_company_dates ON rotation_pauses(company_id, start_date, end_date);
