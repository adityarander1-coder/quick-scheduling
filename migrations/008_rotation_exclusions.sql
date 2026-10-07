-- Rotation shift exclusions: lets admins delete/hide a specific rotation-generated
-- shift instance without editing the rotation pattern.
CREATE TABLE IF NOT EXISTS rotation_shift_exclusions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rotation_id UUID NOT NULL REFERENCES rotations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  shift_type_id UUID REFERENCES shift_types(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rotation_id, user_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS idx_rotexcl_company_date ON rotation_shift_exclusions(company_id, date);
